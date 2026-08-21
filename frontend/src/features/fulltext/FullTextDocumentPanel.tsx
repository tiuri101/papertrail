import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
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
    <div className="grid gap-3">
      {document.isLoading ? <p className="text-text">Checking PDF…</p> : null}
      {document.error ? <p className="text-danger" role="alert">{document.error.message}</p> : null}
      {upload.error ? <p className="text-danger" role="alert">{upload.error.message}</p> : null}
      {remove.error ? <p className="text-danger" role="alert">{remove.error.message}</p> : null}
      {active ? (
        <>
          <p><strong>✓ PDF available</strong></p>
          <p>
            {active.originalFilename} · {formatSize(active.fileSize)}
            <span className="text-text">
              {' · '}Uploaded {new Date(active.uploadedAt).toLocaleDateString()}
              {active.uploadedBy ? ` by ${active.uploadedBy.displayName}` : ''}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button as="a" variant="primary" size="sm" href={`${endpoint}/content`} target="_blank" rel="noreferrer">View PDF</Button>
            <ConfirmButton
              className="h-8 min-h-8 px-3 text-[13px]"
              label="Replace PDF"
              confirmLabel="Replace PDF"
              warning="Replace full text? The previous PDF will be retained in document history."
              onConfirm={openFilePicker}
              disabled={upload.isPending}
              variant="secondary"
              icon={<IconUpload />}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
            >
              {showHistory ? 'Hide document history' : 'Document history'}
            </Button>
            <ConfirmButton
              className="h-8 min-h-8 px-3 text-[13px]"
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
          <p className="text-text">No PDF attached</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" onClick={openFilePicker} disabled={upload.isPending}>
              <IconUpload />
              Upload PDF
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setShowHistory(!showHistory)}
            >
              {showHistory ? 'Hide document history' : 'Document history'}
            </Button>
          </div>
        </>
      ) : null}
      <input
        ref={inputRef}
        className="sr-only"
        aria-label={active ? 'Choose replacement PDF' : 'Choose PDF'}
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => handleFile(event.target.files?.[0])}
      />
      {upload.isPending ? <p role="status">Uploading…</p> : null}
      {showHistory ? (
        <ul className="mb-0 list-disc pl-6">
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
    </div>
  )

  // Wait for the query to settle before mounting the (uncontrolled)
  // CollapsibleSection, so its defaultExpanded reflects real availability
  // instead of the pre-fetch undefined state.
  const settled = !document.isLoading || Boolean(document.error)
  if (!collapsible || !settled) {
    return (
      <section className="my-4 rounded-md border border-border bg-bg-elevated p-4" aria-label="Full text document">
        {content}
      </section>
    )
  }

  return (
    <CollapsibleSection
      title="Full text"
      headingLevel={3}
      className="my-4 rounded-md bg-none bg-bg-elevated p-4 shadow-none"
      defaultExpanded={!active}
    >
      {content}
    </CollapsibleSection>
  )
}
