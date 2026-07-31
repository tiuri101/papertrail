import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { ScreeningItemCard } from '../screening/ScreeningItemCard'
import { useScreeningQueue } from '../screening/useScreeningQueue'

interface RetrievalPublication {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  doi: string | null
  publisherUrl: string | null
}

interface Retrieval {
  id: string
  publicationId: string
  publication: RetrievalPublication
  status: string
  note: string | null
}

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
  const queryClient = useQueryClient()
  const highlightKeywords = useHighlightKeywords(projectId)
  const queue = useScreeningQueue(projectId, 'full_text')

  const retrievals = useQuery({
    queryKey: ['fulltext', projectId],
    queryFn: () => apiRequest<Retrieval[]>(
      `/api/v1/projects/${projectId}/full-text`,
    ),
  })

  const updateRetrieval = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: string; note: string | null }) =>
      apiRequest(`/api/v1/projects/${projectId}/full-text/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status, note }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['fulltext', projectId] })
    },
  })

  const list = retrievals.data ?? []
  const addressedCount = list.filter((retrieval) => retrieval.status !== 'not_yet_sought').length
  const pendingRetrieval = list.find((retrieval) => retrieval.status === 'not_yet_sought')
    ?? list.find((retrieval) => retrieval.status === 'requested')

  const handleSaveRetrieval = async (retrieval: Retrieval, status: string, note: string | null) => {
    await updateRetrieval.mutateAsync({ id: retrieval.id, status, note })
    if (status === 'available') queue.fetchNext()
  }

  const isLoading = retrievals.isLoading || queue.loadingNext

  return (
    <main className="page">
      <h1>Full-text</h1>
      {retrievals.error ? <p className="error" role="alert">{retrievals.error.message}</p> : null}
      {updateRetrieval.error ? <p className="error" role="alert">{updateRetrieval.error.message}</p> : null}
      {queue.nextError ? <p className="error" role="alert">{queue.nextError}</p> : null}
      {list.length > 0 ? (
        <p className="muted">{addressedCount} of {list.length} retrieval decisions made</p>
      ) : null}
      {queue.item ? (
        <ScreeningItemCard {...queue} highlightKeywords={highlightKeywords} />
      ) : isLoading ? (
        <p>Loading…</p>
      ) : list.length === 0 ? (
        <p className="muted">No publications require full-text retrieval.</p>
      ) : pendingRetrieval ? (
        <RetrievalCard
          retrieval={pendingRetrieval}
          saving={updateRetrieval.isPending}
          onSave={(status, note) => handleSaveRetrieval(pendingRetrieval, status, note)}
        />
      ) : (
        <p className="muted">No full-text work is currently available for you.</p>
      )}
    </main>
  )
}

function RetrievalCard({ retrieval, saving, onSave }: {
  retrieval: Retrieval
  saving: boolean
  onSave: (status: string, note: string | null) => void
}) {
  const [status, setStatus] = useState(retrieval.status)
  const [note, setNote] = useState(retrieval.note ?? '')
  const publication = retrieval.publication
  const link = publication.doi ? `https://doi.org/${publication.doi}` : publication.publisherUrl

  return (
    <article className="card">
      <h2>{publication.title}</h2>
      <p className="muted">
        {publication.authors ?? 'Unknown authors'}
        {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
      </p>
      {link ? <p><a href={link} target="_blank" rel="noreferrer">View publication</a></p> : null}
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
      <button type="button" onClick={() => onSave(status, note || null)} disabled={saving}>
        Save
      </button>
    </article>
  )
}
