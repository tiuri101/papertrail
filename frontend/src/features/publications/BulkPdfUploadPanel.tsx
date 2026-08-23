import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconUpload } from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'
import { FileDropZone } from '../imports/FileDropZone'
import { PdfMatchReview } from '../imports/PdfMatchReview'
import type { UploadResult } from '../imports/types'

export function BulkPdfUploadPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [pdfFiles, setPdfFiles] = useState<File[]>([])
  const [pdfArchives, setPdfArchives] = useState<File[]>([])
  const [batchId, setBatchId] = useState<string | null>(null)

  const upload = useMutation({
    mutationFn: async (): Promise<UploadResult> => {
      const form = new FormData()
      pdfFiles.forEach((pdf) => form.append('pdfs', pdf))
      pdfArchives.forEach((archive) => form.append('pdfArchive', archive))
      return apiRequest<UploadResult>(`/api/v1/projects/${projectId}/publications/pdfs`, {
        method: 'POST',
        body: form,
      })
    },
    onSuccess: (result) => {
      setPdfFiles([])
      setPdfArchives([])
      setBatchId(result.importBatchId)
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    },
  })

  const needsReview = upload.data
    ? (upload.data.summary.ambiguous ?? 0)
      + (upload.data.summary.unmatched ?? 0)
      + (upload.data.summary.conflict_existing_pdf ?? 0)
    : 0

  return (
    <CollapsibleSection
      id="section-bulk-pdf-upload"
      title="Bulk Attach PDFs"
      defaultExpanded={false}
    >
      <p className="text-text">
        Upload PDFs to match against every publication in this project by DOI, title, and
        author — no need to select papers first. Anything ambiguous or conflicting will be
        held for you to resolve below.
      </p>
      {upload.error ? <p className="text-danger" role="alert">{upload.error.message}</p> : null}
      <FileDropZone
        id="bulk-pdf-upload"
        label="PDF files"
        hint="PDF files"
        accept="application/pdf,.pdf"
        multiple
        files={pdfFiles}
        onChange={setPdfFiles}
        disabled={upload.isPending}
      />
      <FileDropZone
        id="bulk-pdf-upload-archives"
        label="PDF ZIPs"
        hint="ZIP archives of PDF files"
        accept="application/zip,.zip"
        multiple
        files={pdfArchives}
        onChange={setPdfArchives}
        disabled={upload.isPending}
      />
      <div className={toolbarClass}>
        <Button
          type="button"
          size="sm"
          disabled={(!pdfFiles.length && !pdfArchives.length) || upload.isPending}
          onClick={() => upload.mutate()}
        >
          <IconUpload />
          {upload.isPending ? 'Uploading…' : 'Upload PDFs'}
        </Button>
      </div>
      {upload.data ? (
        <p>
          {upload.data.summary.total} files processed · {upload.data.summary.matched ?? 0} matched
          {needsReview ? ` · ${needsReview} need review` : ''}
        </p>
      ) : null}
      {batchId ? <PdfMatchReview projectId={projectId} importBatchId={batchId} /> : null}
    </CollapsibleSection>
  )
}
