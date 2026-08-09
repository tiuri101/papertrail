import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconTrash, IconUpload } from '../../components/icons'

interface DocumentUser {
  id: string
  displayName: string
}

interface PdfDocument {
  id: string
  originalFilename: string
  fileSize: number
  uploadedAt: string
  uploadedBy: DocumentUser | null
  isActive: boolean
  removedAt: string | null
}

interface FullTextState {
  available: boolean
  document: PdfDocument | null
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FullTextDocumentPanel({ projectId, publicationId, onAvailable, onRemoved }: {
  projectId: string
  publicationId: string
  onAvailable?: () => void
  onRemoved?: () => void
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [showHistory, setShowHistory] = useState(false)
  const queryKey = ['full-text-document', projectId, publicationId]
  const endpoint = `/api/v1/projects/${projectId}/publications/${publicationId}/full-text`
  const document = useQuery({
    queryKey,
    queryFn: () => apiRequest<FullTextState>(endpoint),
    enabled: Boolean(projectId && publicationId),
  })
  const history = useQuery({
    queryKey: [...queryKey, 'history'],
    queryFn: () => apiRequest<PdfDocument[]>(`${endpoint}/history`),
    enabled: showHistory,
  })
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return apiRequest<FullTextState>(endpoint, { method: 'POST', body: form })
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result)
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'history'] })
      onAvailable?.()
    },
  })
  const remove = useMutation({
    mutationFn: () => apiRequest<void>(endpoint, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.setQueryData(queryKey, { available: false, document: null })
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'history'] })
      onRemoved?.()
    },
  })

  const active = document.data?.document
  const openFilePicker = () => inputRef.current?.click()
  const handleFile = (file: File | undefined) => {
    if (file) upload.mutate(file)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <section className="full-text-document" aria-label="Full text document">
      <h3>Full text</h3>
      {document.isLoading ? <p className="muted">Checking PDF…</p> : null}
      {document.error ? <p className="error" role="alert">{document.error.message}</p> : null}
      {upload.error ? <p className="error" role="alert">{upload.error.message}</p> : null}
      {remove.error ? <p className="error" role="alert">{remove.error.message}</p> : null}
      {active ? (
        <>
          <p><strong>✓ PDF available</strong></p>
          <p>
            {active.originalFilename} · {formatSize(active.fileSize)}
            <span className="muted">
              {' · '}Uploaded {new Date(active.uploadedAt).toLocaleDateString()}
              {active.uploadedBy ? ` by ${active.uploadedBy.displayName}` : ''}
            </span>
          </p>
          <div className="toolbar">
            <a href={`${endpoint}/content`} target="_blank" rel="noreferrer">View PDF</a>
            <ConfirmButton
              label="Replace PDF"
              confirmLabel="Replace PDF"
              warning="Replace full text? The previous PDF will be retained in document history."
              onConfirm={openFilePicker}
              disabled={upload.isPending}
              icon={<IconUpload />}
            />
            <ConfirmButton
              label="Remove PDF"
              confirmLabel="Remove PDF"
              warning="Remove the active PDF? Document history will be retained."
              onConfirm={() => remove.mutate()}
              disabled={remove.isPending}
              variant="danger"
              icon={<IconTrash />}
            />
          </div>
        </>
      ) : document.data ? (
        <>
          <p className="muted">No PDF attached</p>
          <button type="button" onClick={openFilePicker} disabled={upload.isPending}>
            <IconUpload />
            Upload PDF
          </button>
        </>
      ) : null}
      <input
        ref={inputRef}
        className="visually-hidden"
        aria-label={active ? 'Choose replacement PDF' : 'Choose PDF'}
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => handleFile(event.target.files?.[0])}
      />
      {upload.isPending ? <p role="status">Uploading…</p> : null}
      <button
        type="button"
        className="link-button full-text-history-toggle"
        onClick={() => setShowHistory(!showHistory)}
      >
        {showHistory ? 'Hide document history' : 'Document history'}
      </button>
      {showHistory ? (
        <ul className="compact-list">
          {history.data?.map((item) => (
            <li key={item.id}>
              {item.isActive ? 'Current' : 'Previous'}: {item.originalFilename}
              {' · '}{new Date(item.uploadedAt).toLocaleDateString()}
              {item.removedAt ? ` · removed ${new Date(item.removedAt).toLocaleDateString()}` : ''}
            </li>
          ))}
          {history.data?.length === 0 ? <li>No document history.</li> : null}
        </ul>
      ) : null}
    </section>
  )
}
