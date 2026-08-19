import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { DoiPill } from '../../components/DoiPill'
import { HighlightedText } from '../../components/HighlightedText'
import { IconAlertTriangle } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { OutcomeBadge } from '../../components/OutcomeBadge'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { ScreeningLlmPanel } from '../llm/LlmTaskComponents'
import { StageEyebrow } from '../projects/StageEyebrow'
import { CriteriaAnswerFields } from './CriteriaAnswerFields'
import type { CriterionAnswer, ScreeningCriterion } from './useScreeningQueue'

interface DecisionPublication {
  id: string
  title: string
  authors: string | null
  abstract: string | null
  publicationYear: number | null
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
  decision: Decision | null
  retrievalStatus?: string | null
  retrievalNote?: string | null
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
  const decision = item.decision!
  const queryClient = useQueryClient()
  const [answers, setAnswers] = useState<Record<string, CriterionAnswer>>(
    () => Object.fromEntries(
      criteria.map((criterion) => [criterion.id, decision.criteriaAnswers[criterion.id] ?? null]),
    ),
  )
  const [outcome, setOutcome] = useState(decision.outcome)
  const [notes, setNotes] = useState(decision.notes ?? '')

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
        criteria={criteria}
        setCriteriaAnswers={setAnswers}
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

const retrievalStatusLabels: Record<string, string> = {
  not_found: 'Full text not found',
  inaccessible: 'Full text inaccessible',
}

const decisionFilterOptions = [
  { value: '', label: 'All decisions' },
  { value: 'include', label: 'Include' },
  { value: 'exclude', label: 'Exclude' },
  { value: 'uncertain', label: 'Uncertain' },
  { value: 'duplicate', label: 'Duplicate' },
  { value: 'not_found', label: 'Full text not found', fullTextOnly: true },
  { value: 'inaccessible', label: 'Full text inaccessible', fullTextOnly: true },
]

function itemStatus(item: MyDecisionItem): string {
  return item.decision?.outcome ?? item.retrievalStatus ?? ''
}

function itemStatusLabel(item: MyDecisionItem): string {
  if (item.decision) return outcomeLabels[item.decision.outcome] ?? item.decision.outcome
  return retrievalStatusLabels[item.retrievalStatus ?? ''] ?? item.retrievalStatus ?? 'Retrieval resolved'
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
  const decision = item.decision

  return (
    <li className="card publication-card decision-card">
      <div className="publication-card__summary">
        <div>
          <h2 className="decision-card__title">
            <HighlightedText text={publication.title} keywords={highlightKeywords} />
          </h2>
          {' — '}{publication.authors ?? 'Unknown authors'}
          {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
        </div>
      </div>
      <div className="publication-card__workflow">
        <OutcomeBadge
          outcome={decision?.outcome ?? 'exclude'}
          label={decision && decision.version > 1 ? `${itemStatusLabel(item)} · v${decision.version}` : itemStatusLabel(item)}
        />
        <DoiPill doi={publication.doi} />
        {isSafeHttpUrl(publication.publisherUrl) ? (
          <PublisherLinkPill url={publication.publisherUrl!} />
        ) : null}
      </div>
      <details className="publication-card__abstract">
        <summary>Publication details</summary>
        {publication.venue ? <p><strong>Venue:</strong> {publication.venue}</p> : null}
        <p>
          <strong>Abstract:</strong>{' '}
          {publication.abstract
            ? <HighlightedText text={publication.abstract} keywords={highlightKeywords} />
            : 'No abstract available.'}
        </p>
        {decision?.notes ? <p><strong>Notes:</strong> {decision.notes}</p> : null}
        {item.retrievalNote ? <p><strong>Notes:</strong> {item.retrievalNote}</p> : null}
        {item.submittedAt ? <p className="muted">Submitted {new Date(item.submittedAt).toLocaleString()}</p> : null}
      </details>
      {editing && decision ? (
        <DecisionEditForm
          projectId={projectId}
          stage={stage}
          item={item}
          criteria={criteria}
          stageCompleted={stageCompleted}
          onDone={() => setEditing(false)}
          onWorkflowImpact={onWorkflowImpact}
        />
      ) : decision ? (
        <div className="toolbar publication-card__actions">
          <button type="button" className="button-secondary" onClick={() => setEditing(true)}>Edit Decision</button>
        </div>
      ) : null}
    </li>
  )
}

export function MyDecisionsPage() {
  const { projectId = '', stage = 'title_abstract' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const [workflowImpact, setWorkflowImpact] = useState<WorkflowImpact | null>(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sort, setSort] = useState('newest')
  const query = useQuery({
    queryKey: ['my-decisions', projectId, stage],
    queryFn: () => apiRequest<MyDecisionsResponse>(
      `/api/v1/projects/${projectId}/screening/${stage}/my-decisions`,
    ),
  })

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const items = (query.data?.items ?? []).filter((item) => {
      const publication = item.publication
      const searchable = [
        publication.title,
        publication.authors,
        publication.abstract,
        publication.venue,
        publication.doi,
        item.decision?.notes,
        item.retrievalNote,
      ].filter(Boolean).join(' ').toLocaleLowerCase()
      return (!normalizedSearch || searchable.includes(normalizedSearch))
        && (!statusFilter || itemStatus(item) === statusFilter)
    })
    return items.sort((left, right) => {
      if (sort === 'title_asc') return left.publication.title.localeCompare(right.publication.title)
      if (sort === 'title_desc') return right.publication.title.localeCompare(left.publication.title)
      const leftTime = left.submittedAt ? Date.parse(left.submittedAt) : 0
      const rightTime = right.submittedAt ? Date.parse(right.submittedAt) : 0
      return sort === 'oldest' ? leftTime - rightTime : rightTime - leftTime
    })
  }, [query.data?.items, search, sort, statusFilter])

  return (
    <main className="page">
      <StageEyebrow
        stage={stage === 'full_text' ? 'full_text_screening' : 'title_abstract_screening'}
      />
      <h1>My {stageTitles[stage] ?? stage} Decisions</h1>
      <p className="muted">
        Decisions you have already submitted for this stage. Open one to review or revise it.
      </p>
      <p>
        <Link to={stage === 'full_text' ? `/projects/${projectId}/full-text` : `/projects/${projectId}/screening/${stage}`}>
          ← Back to screening queue
        </Link>
      </p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data ? (
        <>
          {query.data.stageCompleted ? (
            <InfoBox icon={<IconAlertTriangle />} tone="warning" alert>
              <h3>This stage has been completed</h3>
              <p>
                You can still change a decision, but doing so may affect results that have already been finalized.
                Background jobs will be run automatically, but you might have to complete tasks such as screening or
                data extraction manually.
              </p>
            </InfoBox>
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
          {query.data.items.length > 0 ? (
            <>
              <p className="muted">
                {search || statusFilter
                  ? `${filteredItems.length} of ${query.data.items.length} decisions match your filters`
                  : `${query.data.items.length} decision${query.data.items.length === 1 ? '' : 's'}`}
              </p>
              <div className="toolbar">
                <label className="paper-search-field">
                  Search papers
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Title, author, DOI, note…"
                  />
                </label>
                <label>
                  Decision
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                    {decisionFilterOptions
                      .filter((option) => !option.fullTextOnly || stage === 'full_text')
                      .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label>
                  Sort by
                  <select value={sort} onChange={(event) => setSort(event.target.value)}>
                    <option value="newest">Newest decision</option>
                    <option value="oldest">Oldest decision</option>
                    <option value="title_asc">Title A–Z</option>
                    <option value="title_desc">Title Z–A</option>
                  </select>
                </label>
              </div>
            </>
          ) : null}
          {query.data.items.length === 0 ? (
            <p className="muted">You have not submitted any decisions for this stage yet.</p>
          ) : filteredItems.length === 0 ? (
            <p className="muted">No decisions match your filters.</p>
          ) : (
            <ul className="card-list stacked publication-list">
              {filteredItems.map((item) => (
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
