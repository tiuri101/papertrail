import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { IconUpload } from '../../components/icons'
import { FileDropZone } from './FileDropZone'
import { PdfMatchReview, type PdfSummary } from './PdfMatchReview'

interface UploadResult {
  importBatchId: string
  summary: PdfSummary
}

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
    <section className="card nested-card">
      <h3>Attach PDFs</h3>
      {upload.error ? <p className="error" role="alert">{upload.error.message}</p> : null}
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
      <div className="toolbar">
        <button
          type="button"
          disabled={(!pdfFiles.length && !pdfArchives.length) || upload.isPending}
          onClick={() => upload.mutate()}
        >
          <IconUpload />
          {upload.isPending ? 'Uploading…' : 'Upload PDFs'}
        </button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {upload.data ? (
        <p>
          {upload.data.summary.total} files processed · {upload.data.summary.matched ?? 0} matched
        </p>
      ) : null}
      {showReview ? <PdfMatchReview projectId={projectId} importBatchId={importBatchId} /> : null}
    </section>
  )
}
