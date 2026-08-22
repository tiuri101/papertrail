import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { IconUpload } from '../../components/icons'
import { FileDropZone } from './FileDropZone'
import { PdfMatchReview } from './PdfMatchReview'
import type { UploadResult } from './types'

export function AttachPdfsPanel({ projectId, importBatchId, onClose }: {
  projectId: string
  importBatchId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [pdfFiles, setPdfFiles] = useState<File[]>([])
  const [pdfArchives, setPdfArchives] = useState<File[]>([])
  const [showReview, setShowReview] = useState(false)

  const upload = useMutation({
    mutationFn: async (): Promise<UploadResult> => {
      const form = new FormData()
      pdfFiles.forEach((pdf) => form.append('pdfs', pdf))
      pdfArchives.forEach((archive) => form.append('pdfArchive', archive))
      return apiRequest<UploadResult>(
        `/api/v1/projects/${projectId}/imports/${importBatchId}/pdfs`,
        { method: 'POST', body: form },
      )
    },
    onSuccess: () => {
      setPdfFiles([])
      setPdfArchives([])
      setShowReview(true)
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    },
  })

  return (
    <Card as="section" className="rounded-md p-4 [&>*+*]:mt-3">
      <h3>Attach PDFs</h3>
      {upload.error ? <p className="text-danger" role="alert">{upload.error.message}</p> : null}
      <FileDropZone
        id={`attach-pdfs-${importBatchId}`}
        label="PDF files"
        hint="PDF files"
        accept="application/pdf,.pdf"
        multiple
        files={pdfFiles}
        onChange={setPdfFiles}
        disabled={upload.isPending}
      />
      <FileDropZone
        id={`attach-pdf-archives-${importBatchId}`}
        label="PDF ZIPs"
        hint="ZIP archives of PDF files"
        accept="application/zip,.zip"
        multiple
        files={pdfArchives}
        onChange={setPdfArchives}
        disabled={upload.isPending}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={(!pdfFiles.length && !pdfArchives.length) || upload.isPending}
          onClick={() => upload.mutate()}
        >
          <IconUpload />
          {upload.isPending ? 'Uploading…' : 'Upload PDFs'}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>Close</Button>
      </div>
      {upload.data ? (
        <p>
          {upload.data.summary.total} files processed · {upload.data.summary.matched ?? 0} matched
        </p>
      ) : null}
      {showReview ? <PdfMatchReview projectId={projectId} importBatchId={importBatchId} /> : null}
    </Card>
  )
}
