import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { HighlightedText } from '../../components/HighlightedText'
import { OutcomeBadge } from '../../components/OutcomeBadge'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { ScreeningLlmPanel } from '../llm/LlmTaskComponents'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import type { CriterionAnswer, ScreeningCriterion } from './useScreeningQueue'

interface DecisionPublication {
  id: string
  title: string
  authors: string | null
  abstract: string | null
  venue: string | null
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

interface DecisionRevisionResponse extends Decision {
  projectStage?: string | null
  stageUnchanged?: boolean
  pendingWorkflowSteps?: string[]
}

interface WorkflowImpact {
  publicationTitle: string
  projectStage: string | null
  pendingSteps: string[]
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

const projectStageTitles: Record<string, string> = {
  draft: 'Draft',
  duplicate_review: 'Duplicate Review',
  title_abstract_screening: 'Title/Abstract Screening',
  full_text_screening: 'Full-Text Screening',
  extraction_quality: 'Data Extraction and Quality Assessment',
  completed: 'Completed',
}

function DecisionEditForm({
  projectId,
  stage,
  item,
  criteria,
  stageCompleted,
  onDone,
  onWorkflowImpact,
}: {
  projectId: string
  stage: string
  item: MyDecisionItem
  criteria: ScreeningCriterion[]
  stageCompleted: boolean
  onDone: () => void
  onWorkflowImpact: (impact: WorkflowImpact) => void
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
    mutationFn: () => apiRequest<DecisionRevisionResponse>(
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
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['my-decisions', projectId, stage] })
      if (response.stageUnchanged) {
        onWorkflowImpact({
          publicationTitle: item.publication.title,
          projectStage: response.projectStage ?? null,
          pendingSteps: response.pendingWorkflowSteps ?? [],
        })
      }
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
      <ScreeningLlmPanel
        projectId={projectId}
        publicationId={item.publication.id}
        itemId={item.workItemId}
        stage={stage as 'title_abstract' | 'full_text'}
        humanDecision={outcome}
        criteriaAnswers={answers}
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
  highlightKeywords,
  onWorkflowImpact,
}: {
  projectId: string
  stage: string
  item: MyDecisionItem
  criteria: ScreeningCriterion[]
  stageCompleted: boolean
  highlightKeywords: string[]
  onWorkflowImpact: (impact: WorkflowImpact) => void
}) {
  const [editing, setEditing] = useState(false)
  const publication = item.publication

  return (
    <li className="card">
      <h2><HighlightedText text={publication.title} keywords={highlightKeywords} /></h2>
      <p>{publication.authors ?? 'Unknown authors'}</p>
      {publication.venue ? <p className="muted">{publication.venue}</p> : null}
      <p>
        {publication.abstract
          ? <HighlightedText text={publication.abstract} keywords={highlightKeywords} />
          : 'No abstract available.'}
      </p>
      <div className="toolbar">
        {publication.doi ? (
          <a href={`https://doi.org/${publication.doi}`} target="_blank" rel="noreferrer">
            Open DOI
          </a>
        ) : null}
        {isSafeHttpUrl(publication.publisherUrl) ? (
          <a href={publication.publisherUrl} target="_blank" rel="noreferrer">
            Open publisher page
          </a>
        ) : null}
      </div>
      {editing ? (
        <DecisionEditForm
          projectId={projectId}
          stage={stage}
          item={item}
          criteria={criteria}
          stageCompleted={stageCompleted}
          onDone={() => setEditing(false)}
          onWorkflowImpact={onWorkflowImpact}
        />
      ) : (
        <>
          <p>
            <strong>Decision:</strong>{' '}
            <OutcomeBadge
              outcome={item.decision.outcome}
              label={outcomeLabels[item.decision.outcome] ?? item.decision.outcome}
            />
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
  const highlightKeywords = useHighlightKeywords(projectId)
  const [workflowImpact, setWorkflowImpact] = useState<WorkflowImpact | null>(null)
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
          {workflowImpact ? (
            <section className="error alert" role="alert" aria-labelledby="revision-impact-heading">
              <h2 id="revision-impact-heading">Decision revised without changing the project stage</h2>
              <p>
                The project remains in{' '}
                <strong>
                  {workflowImpact.projectStage
                    ? projectStageTitles[workflowImpact.projectStage] ?? workflowImpact.projectStage
                    : 'its current stage'}
                </strong>.
              </p>
              {workflowImpact.pendingSteps.length ? (
                <>
                  <p>Outstanding work for {workflowImpact.publicationTitle}:</p>
                  <ul>
                    {workflowImpact.pendingSteps.map((step) => <li key={step}>{step}</li>)}
                  </ul>
                </>
              ) : (
                <p>No additional workflow steps are currently required for this publication.</p>
              )}
            </section>
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
                  highlightKeywords={highlightKeywords}
                  onWorkflowImpact={setWorkflowImpact}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </main>
  )
}
