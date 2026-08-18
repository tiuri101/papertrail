import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconTrash, IconUpload } from '../../components/icons'
import {
  fullTextDocumentEndpoint,
  fullTextDocumentQueryKey,
  type FullTextDocumentState,
  type FullTextPdfDocument,
} from './useFullTextDocument'

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FullTextDocumentPanel({ projectId, publicationId, onAvailable, onRemoved, collapsible = false }: {
  projectId: string
  publicationId: string
  onAvailable?: () => void
  onRemoved?: () => void
  collapsible?: boolean
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [showHistory, setShowHistory] = useState(false)
  const queryKey = fullTextDocumentQueryKey(projectId, publicationId)
  const endpoint = fullTextDocumentEndpoint(projectId, publicationId)
  const document = useQuery({
    queryKey,
    queryFn: () => apiRequest<FullTextDocumentState>(endpoint),
    enabled: Boolean(projectId && publicationId),
  })
  const history = useQuery({
    queryKey: [...queryKey, 'history'],
    queryFn: () => apiRequest<FullTextPdfDocument[]>(`${endpoint}/history`),
    enabled: showHistory,
  })
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      return apiRequest<FullTextDocumentState>(endpoint, { method: 'POST', body: form })
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

  const content = (
    <>
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
            <a className="button-primary button-sm" href={`${endpoint}/content`} target="_blank" rel="noreferrer">View PDF</a>
            <ConfirmButton
              className="button-sm"
              label="Replace PDF"
              confirmLabel="Replace PDF"
              warning="Replace full text? The previous PDF will be retained in document history."
              onConfirm={openFilePicker}
              disabled={upload.isPending}
              variant="secondary"
              icon={<IconUpload />}
            />
            <button
              type="button"
              className="button-secondary button-sm"
              onClick={() => setShowHistory(!showHistory)}
            >
              {showHistory ? 'Hide document history' : 'Document history'}
            </button>
            <ConfirmButton
              className="button-sm"
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
          <button type="button" className="button-sm" onClick={openFilePicker} disabled={upload.isPending}>
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
      {!active ? (
        <button
          type="button"
          className="button-secondary button-sm full-text-history-toggle"
          onClick={() => setShowHistory(!showHistory)}
        >
          {showHistory ? 'Hide document history' : 'Document history'}
        </button>
      ) : null}
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
    </>
  )

  // Wait for the query to settle before mounting the (uncontrolled)
  // CollapsibleSection, so its defaultExpanded reflects real availability
  // instead of the pre-fetch undefined state.
  const settled = !document.isLoading || Boolean(document.error)
  if (!collapsible || !settled) {
    return (
      <section className="full-text-document" aria-label="Full text document">
        {content}
      </section>
    )
  }

  return (
    <CollapsibleSection
      title="Full text"
      headingLevel={3}
      className="full-text-document"
      defaultExpanded={!active}
    >
      {content}
    </CollapsibleSection>
  )
}
