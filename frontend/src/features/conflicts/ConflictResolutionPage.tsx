import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface ConflictPublication {
  id: string
  title: string
  authors: string | null
  abstract: string | null
  doi: string | null
  publisherUrl: string | null
}

interface ConflictDecision {
  reviewer: { id: string; displayName: string }
  outcome: string
  exclusionReasonText: string | null
  notes: string | null
}

interface ConflictItem {
  publicationId: string
  publication: ConflictPublication
  decisions: ConflictDecision[]
}

const outcomes = ['include', 'exclude', 'uncertain', 'duplicate']

const outcomeLabels: Record<string, string> = {
  include: 'Include',
  exclude: 'Exclude',
  uncertain: 'Uncertain',
  duplicate: 'Duplicate',
}

function formatOutcome(outcome: string) {
  return outcomeLabels[outcome] ?? outcome
}

export function ConflictResolutionPage() {
  const { projectId = '', stage = 'title_abstract' } = useParams()
  const queryClient = useQueryClient()
  const conflicts = useQuery({
    queryKey: ['conflicts', projectId, stage],
    queryFn: () => apiRequest<ConflictItem[]>(
      `/api/v1/projects/${projectId}/screening/${stage}/conflicts`,
    ),
  })
  const resolve = useMutation({
    mutationFn: ({ publicationId, outcome, note }: { publicationId: string; outcome: string; note: string | null }) =>
      apiRequest(
        `/api/v1/projects/${projectId}/screening/${stage}/publications/${publicationId}/final`,
        {
          method: 'POST',
          body: JSON.stringify({
            outcome,
            resolutionMethod: 'admin_consensus',
            note,
          }),
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: ['conflicts', projectId, stage],
    }),
  })
  const addReviewer = useMutation({
    mutationFn: (publicationId: string) =>
      apiRequest(
        `/api/v1/projects/${projectId}/screening/${stage}/publications/${publicationId}/additional-reviewer`,
        { method: 'POST' },
      ),
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: ['conflicts', projectId, stage],
    }),
  })

  const list = conflicts.data ?? []

  return (
    <main className="page">
      <h1>Conflict resolution</h1>
      {conflicts.error ? <p className="error" role="alert">{conflicts.error.message}</p> : null}
      {resolve.error ? <p className="error" role="alert">{resolve.error.message}</p> : null}
      {addReviewer.error ? <p className="error" role="alert">{addReviewer.error.message}</p> : null}
      <p>{list.length} unresolved publications</p>
      <ul className="card-list stacked">
        {list.map((conflict) => (
          <ConflictCard
            key={conflict.publicationId}
            conflict={conflict}
            resolving={resolve.isPending}
            addingReviewer={addReviewer.isPending}
            onResolve={(outcome, note) => resolve.mutate({ publicationId: conflict.publicationId, outcome, note })}
            onAddReviewer={() => addReviewer.mutate(conflict.publicationId)}
          />
        ))}
      </ul>
    </main>
  )
}

function ConflictCard({ conflict, resolving, addingReviewer, onResolve, onAddReviewer }: {
  conflict: ConflictItem
  resolving: boolean
  addingReviewer: boolean
  onResolve: (outcome: string, note: string | null) => void
  onAddReviewer: () => void
}) {
  const [note, setNote] = useState('')
  const publication = conflict.publication
  const link = publication.doi ? `https://doi.org/${publication.doi}` : publication.publisherUrl

  return (
    <li className="card">
      <h2>{publication.title}</h2>
      <p className="muted">{publication.authors ?? 'Unknown authors'}</p>
      {publication.abstract ? <p>{publication.abstract}</p> : null}
      {link ? <p><a href={link} target="_blank" rel="noreferrer">View publication</a></p> : null}
      <h3>Reviewer decisions</h3>
      <table>
        <thead>
          <tr>
            <th scope="col">Reviewer</th>
            <th scope="col">Decision</th>
            <th scope="col">Reason / notes</th>
          </tr>
        </thead>
        <tbody>
          {conflict.decisions.map((decision) => (
            <tr key={decision.reviewer.id}>
              <th scope="row">{decision.reviewer.displayName}</th>
              <td>{formatOutcome(decision.outcome)}</td>
              <td>{decision.exclusionReasonText ?? decision.notes ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <label>
        Resolution note
        <textarea value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="toolbar">
        {outcomes.map((outcome) => (
          <button
            type="button"
            key={outcome}
            onClick={() => onResolve(outcome, note || null)}
            disabled={resolving}
          >
            {formatOutcome(outcome)}
          </button>
        ))}
        <button type="button" onClick={onAddReviewer} disabled={addingReviewer}>
          Add another reviewer
        </button>
      </div>
    </li>
  )
}
