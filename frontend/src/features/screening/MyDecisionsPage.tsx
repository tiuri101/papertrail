import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import type { CriterionAnswer, ScreeningCriterion } from './useScreeningQueue'

interface DecisionPublication {
  title: string
  authors: string | null
  abstract: string | null
  doi: string | null
  publisherUrl: string | null
}

interface Decision {
  id: string
  outcome: string
  criteriaAnswers: Record<string, boolean>
  notes: string | null
  version: number
}

interface MyDecisionItem {
  workItemId: string
  submittedAt: string | null
  publication: DecisionPublication
  decision: Decision
}

interface MyDecisionsResponse {
  stageCompleted: boolean
  criteria: ScreeningCriterion[]
  items: MyDecisionItem[]
}

const stageTitles: Record<string, string> = {
  title_abstract: 'Title/Abstract',
  full_text: 'Full-Text',
}

function DecisionEditForm({
  projectId,
  stage,
  item,
  criteria,
  stageCompleted,
  onDone,
}: {
  projectId: string
  stage: string
  item: MyDecisionItem
  criteria: ScreeningCriterion[]
  stageCompleted: boolean
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, CriterionAnswer>>(
    () => Object.fromEntries(
      criteria.map((criterion) => [criterion.id, item.decision.criteriaAnswers[criterion.id] ?? null]),
    ),
  )
  const [outcome, setOutcome] = useState(item.decision.outcome)
  const [notes, setNotes] = useState(item.decision.notes ?? '')

  const save = useMutation({
    mutationFn: () => apiRequest(
      `/api/v1/projects/${projectId}/screening/work-items/${item.workItemId}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({
          outcome,
          criteriaAnswers: answers,
          notes: notes || null,
        }),
      },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['my-decisions', projectId, stage] })
      onDone()
    },
  })

  const criteriaComplete = criteria.every(
    (criterion) => answers[criterion.id] !== null && answers[criterion.id] !== undefined,
  )

  return (
    <>
      <CriteriaAnswerFields
        criteria={criteria}
        answers={answers}
        setAnswers={setAnswers}
        outcome={outcome}
        setOutcome={setOutcome}
        notes={notes}
        setNotes={setNotes}
      />
      {!criteriaComplete ? (
        <p className="muted">Answer every criterion before saving.</p>
      ) : null}
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <div className="toolbar">
        {stageCompleted ? (
          <ConfirmButton
            label="Save Changes"
            confirmLabel="Save Anyway"
            warning={`The ${stageTitles[stage] ?? stage} stage is already complete. Changing this decision may affect results that have already been finalized.`}
            onConfirm={() => save.mutate()}
            disabled={save.isPending || !criteriaComplete}
          />
        ) : (
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending || !criteriaComplete}>
            Save Changes
          </button>
        )}
        <button type="button" className="button-secondary" onClick={onDone} disabled={save.isPending}>
          Cancel
        </button>
      </div>
    </>
  )
}

const outcomeLabels: Record<string, string> = {
  include: 'Include',
  exclude: 'Exclude',
  uncertain: 'Uncertain',
  duplicate: 'Duplicate',
}

function DecisionCard({
  projectId,
  stage,
  item,
  criteria,
  stageCompleted,
}: {
  projectId: string
  stage: string
  item: MyDecisionItem
  criteria: ScreeningCriterion[]
  stageCompleted: boolean
}) {
  const [editing, setEditing] = useState(false)
  const publication = item.publication
  const link = publication.doi ? `https://doi.org/${publication.doi}` : publication.publisherUrl

  return (
    <li className="card">
      <h2>{publication.title}</h2>
      <p className="muted">{publication.authors ?? 'Unknown authors'}</p>
      {link ? <p><a href={link} target="_blank" rel="noreferrer">View publication</a></p> : null}
      {editing ? (
        <DecisionEditForm
          projectId={projectId}
          stage={stage}
          item={item}
          criteria={criteria}
          stageCompleted={stageCompleted}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <p>
            <strong>Decision:</strong> {outcomeLabels[item.decision.outcome] ?? item.decision.outcome}
            {item.decision.version > 1 ? <span className="muted"> (revised, v{item.decision.version})</span> : null}
          </p>
          {item.decision.notes ? <p><strong>Notes:</strong> {item.decision.notes}</p> : null}
          <div className="toolbar">
            <button type="button" onClick={() => setEditing(true)}>Edit Decision</button>
          </div>
        </>
      )}
    </li>
  )
}

export function MyDecisionsPage() {
  const { projectId = '', stage = 'title_abstract' } = useParams()
  const query = useQuery({
    queryKey: ['my-decisions', projectId, stage],
    queryFn: () => apiRequest<MyDecisionsResponse>(
      `/api/v1/projects/${projectId}/screening/${stage}/my-decisions`,
    ),
  })

  return (
    <main className="page">
      <h1>My {stageTitles[stage] ?? stage} Decisions</h1>
      <p><Link to={`/projects/${projectId}/screening/${stage}`}>← Back to screening queue</Link></p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data ? (
        <>
          {query.data.stageCompleted ? (
            <p className="error" role="alert">
              This stage has been completed. You can still change a decision, but doing so may affect results that
              have already been finalized.
            </p>
          ) : null}
          {query.data.items.length === 0 ? (
            <p className="muted">You have not submitted any decisions for this stage yet.</p>
          ) : (
            <ul className="card-list stacked">
              {query.data.items.map((item) => (
                <DecisionCard
                  key={item.workItemId}
                  projectId={projectId}
                  stage={stage}
                  item={item}
                  criteria={query.data!.criteria}
                  stageCompleted={query.data!.stageCompleted}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </main>
  )
}
