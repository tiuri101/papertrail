import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { CountPill } from '../../components/CountPill'
import { Textarea } from '../../components/Textarea'
import { useProjectManageState } from '../../hooks/useCanManageProject'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { StageEyebrow } from '../projects/StageEyebrow'

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
  const { canManage, isLoading: canManageLoading } = useProjectManageState(projectId)
  const conflicts = useQuery({
    queryKey: ['conflicts', projectId, stage],
    queryFn: () => apiRequest<ConflictItem[]>(
      `/api/v1/projects/${projectId}/screening/${stage}/conflicts`,
    ),
    enabled: Boolean(projectId) && canManage,
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

  if (canManageLoading) {
    return <main className="page"><p>Loading…</p></main>
  }
  if (!canManage) {
    return (
      <main className="page">
        <StageEyebrow
          stage={stage === 'full_text' ? 'full_text_screening' : 'title_abstract_screening'}
        />
        <h1>Conflict Resolution</h1>
        <p className="error" role="alert">
          Only the project owner or an administrator can resolve conflicts.
        </p>
      </main>
    )
  }

  return (
    <main className="page">
      <StageEyebrow
        stage={stage === 'full_text' ? 'full_text_screening' : 'title_abstract_screening'}
      />
      <h1>Conflict Resolution</h1>
      {conflicts.error ? <p className="error" role="alert">{conflicts.error.message}</p> : null}
      {resolve.error ? <p className="error" role="alert">{resolve.error.message}</p> : null}
      {addReviewer.error ? <p className="error" role="alert">{addReviewer.error.message}</p> : null}
      <CountPill count={list.length}>unresolved conflicts</CountPill>
      <ul className="m-0 grid list-none gap-5 p-0" aria-label="Unresolved conflicts">
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
  const link = publication.doi
    ? `https://doi.org/${publication.doi}`
    : isSafeHttpUrl(publication.publisherUrl) ? publication.publisherUrl : null

  return (
    <Card as="li">
      <h2>{publication.title}</h2>
      <p className="muted">{publication.authors ?? 'Unknown authors'}</p>
      {publication.abstract ? <p>{publication.abstract}</p> : null}
      {link ? <p><a href={link} target="_blank" rel="noreferrer">View publication</a></p> : null}
      <h3>Reviewer Decisions</h3>
      <div className="overflow-x-auto">
      <table className="min-w-[36rem]">
        <thead>
          <tr>
            <th scope="col">Reviewer</th>
            <th scope="col">Decision</th>
            <th scope="col">Notes</th>
          </tr>
        </thead>
        <tbody>
          {conflict.decisions.map((decision) => (
            <tr key={decision.reviewer.id}>
              <th scope="row">{decision.reviewer.displayName}</th>
              <td>{formatOutcome(decision.outcome)}</td>
              <td>{decision.notes ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <label className="grid gap-2 text-sm font-semibold text-text-secondary">
        Resolution note
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-3">
        {outcomes.map((outcome) => (
          <Button
            type="button"
            key={outcome}
            variant={outcome === 'include' ? 'primary' : 'secondary'}
            onClick={() => onResolve(outcome, note || null)}
            disabled={resolving}
          >
            {formatOutcome(outcome)}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="secondary" onClick={onAddReviewer} disabled={addingReviewer}>
          Add Another Reviewer
        </Button>
      </div>
    </Card>
  )
}
