import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

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

// Display order: the default status first, "available" last.
const statusLabels: Record<string, string> = {
  not_yet_sought: 'Not yet sought',
  requested: 'Requested',
  not_found: 'Not found',
  inaccessible: 'Inaccessible',
  available: 'Available',
}

const statusOrder = Object.keys(statusLabels)

function formatStatus(status: string) {
  return statusLabels[status] ?? status
}

export function FullTextPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const retrievals = useQuery({
    queryKey: ['fulltext', projectId],
    queryFn: () => apiRequest<Retrieval[]>(
      `/api/v1/projects/${projectId}/full-text`,
    ),
  })
  const update = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: string; note: string | null }) =>
      apiRequest(`/api/v1/projects/${projectId}/full-text/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status, note }),
      }),
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: ['fulltext', projectId],
    }),
  })

  const list = retrievals.data ?? []
  const addressedCount = list.filter((retrieval) => retrieval.status !== 'not_yet_sought').length

  return (
    <main className="page">
      <h1>Full-text retrieval</h1>
      {retrievals.error ? <p className="error" role="alert">{retrievals.error.message}</p> : null}
      {update.error ? <p className="error" role="alert">{update.error.message}</p> : null}
      {retrievals.isLoading ? <p>Loading…</p> : null}
      {!retrievals.isLoading && list.length === 0 ? (
        <p className="muted">No publications require full-text retrieval.</p>
      ) : null}
      {list.length > 0 ? (
        <p className="muted">{addressedCount} of {list.length} addressed</p>
      ) : null}
      {statusOrder.map((statusValue) => {
        const items = list.filter((retrieval) => retrieval.status === statusValue)
        if (items.length === 0) return null
        return (
          <div key={statusValue}>
            <h2>{formatStatus(statusValue)} ({items.length})</h2>
            <ul className="card-list">
              {items.map((retrieval) => (
                <RetrievalRow
                  key={retrieval.id}
                  retrieval={retrieval}
                  saving={update.isPending}
                  onSave={(status, note) => update.mutate({ id: retrieval.id, status, note })}
                />
              ))}
            </ul>
          </div>
        )
      })}
    </main>
  )
}

function RetrievalRow({ retrieval, saving, onSave }: {
  retrieval: Retrieval
  saving: boolean
  onSave: (status: string, note: string | null) => void
}) {
  const [status, setStatus] = useState(retrieval.status)
  const [note, setNote] = useState(retrieval.note ?? '')
  const publication = retrieval.publication
  const link = publication.doi ? `https://doi.org/${publication.doi}` : publication.publisherUrl

  return (
    <li className="card">
      <h3>{publication.title}</h3>
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
          {statusOrder.map((statusOption) => (
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
    </li>
  )
}
