import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { ScreeningItemCard } from '../screening/ScreeningItemCard'
import { useScreeningQueue } from '../screening/useScreeningQueue'
import type { Retrieval } from './useRetrievalQueue'
import { useRetrievalQueue } from './useRetrievalQueue'
import { FullTextDocumentPanel } from './FullTextDocumentPanel'

const statusLabels: Record<string, string> = {
  not_yet_sought: 'Not yet sought',
  requested: 'Requested',
  not_found: 'Not found',
  inaccessible: 'Inaccessible',
  available: 'Available',
}

function formatStatus(status: string) {
  return statusLabels[status] ?? status
}

const retrievalStatusOptions = Object.keys(statusLabels)

export function FullTextPage() {
  const { projectId = '' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const queue = useScreeningQueue(projectId, 'full_text')
  const retrievalQueue = useRetrievalQueue(projectId)

  const updateRetrieval = useMutation({
    mutationFn: ({ id, status, note }: {
      id: string
      status: string
      note: string | null
    }) =>
      apiRequest<{ decisionSubmitted: boolean }>(`/api/v1/projects/${projectId}/full-text/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status, note, decision: null }),
      }),
  })

  const handleSubmit = async (
    retrieval: Retrieval,
    status: string,
    note: string | null,
  ) => {
    await updateRetrieval.mutateAsync({ id: retrieval.id, status, note })
    if (status === 'available') queue.fetchNext()
    retrievalQueue.advance()
  }

  const progress = retrievalQueue.progress
  const isLoading = retrievalQueue.loadingNext || queue.loadingNext || progress === undefined

  const itemId = queue.item?.id
  useEffect(() => {
    if (itemId) window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [itemId])

  return (
    <main className="page">
      <h1>Full-Text</h1>
      {retrievalQueue.nextError ? <p className="error" role="alert">{retrievalQueue.nextError}</p> : null}
      {updateRetrieval.error ? <p className="error" role="alert">{updateRetrieval.error.message}</p> : null}
      {queue.nextError ? <p className="error" role="alert">{queue.nextError}</p> : null}
      {progress ? (
        <p className="muted">{progress.addressed} of {progress.total} retrieval decisions made</p>
      ) : null}
      {queue.item ? (
        <>
          <FullTextDocumentPanel
            projectId={projectId}
            publicationId={queue.item.publication.id}
          />
          <ScreeningItemCard {...queue} highlightKeywords={highlightKeywords} />
        </>
      ) : isLoading ? (
        <p>Loading…</p>
      ) : progress?.total === 0 ? (
        <p className="muted">No publications require full-text retrieval.</p>
      ) : retrievalQueue.item ? (
        <RetrievalCard
          projectId={projectId}
          retrieval={retrievalQueue.item}
          saving={updateRetrieval.isPending}
          onSubmit={(status, note) => handleSubmit(retrievalQueue.item!, status, note)}
        />
      ) : (
        <p className="muted">No full-text work is currently available for you.</p>
      )}
    </main>
  )
}

function RetrievalCard({ projectId, retrieval, saving, onSubmit }: {
  projectId: string
  retrieval: Retrieval
  saving: boolean
  onSubmit: (status: string, note: string | null) => void
}) {
  const [status, setStatus] = useState(retrieval.status)
  const [note, setNote] = useState(retrieval.note ?? '')
  const publication = retrieval.publication
  const isAvailable = status === 'available'

  const handleSubmit = () => {
    onSubmit(status, note || null)
  }

  return (
    <article className="card">
      <h2>{publication.title}</h2>
      <p className="muted">
        {publication.authors ?? 'Unknown authors'}
        {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
      </p>
      <div className="toolbar">
        {publication.doi ? (
          <a href={`https://doi.org/${publication.doi}`} target="_blank" rel="noreferrer">
            Open DOI
          </a>
        ) : null}
        {isSafeHttpUrl(publication.publisherUrl) ? (
          <a href={publication.publisherUrl!} target="_blank" rel="noreferrer">
            Open publisher page
          </a>
        ) : null}
      </div>
      <FullTextDocumentPanel
        projectId={projectId}
        publicationId={publication.id}
        onAvailable={() => setStatus('available')}
      />
      <label>
        Retrieval status for {publication.title}
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {retrievalStatusOptions.map((statusOption) => (
            <option value={statusOption} key={statusOption}>{formatStatus(statusOption)}</option>
          ))}
        </select>
      </label>
      <label>
        Note for {publication.title}
        <textarea value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {isAvailable ? (
        <p className="muted">
          Save the available status to open full-text screening and its LLM evidence panel.
        </p>
      ) : null}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={saving}
      >
        {isAvailable ? 'Save and start screening' : 'Submit'}
      </button>
    </article>
  )
}
