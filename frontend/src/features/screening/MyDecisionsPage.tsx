import { toolbarClass } from '../../components/layoutStyles'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Page } from '../../components/Page'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CountPill } from '../../components/CountPill'
import { DoiPill } from '../../components/DoiPill'
import { HighlightedText } from '../../components/HighlightedText'
import { IconAlertTriangle } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Input } from '../../components/Input'
import { OutcomeBadge } from '../../components/OutcomeBadge'
import { Select } from '../../components/Select'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
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
        <p className="text-text-muted">Answer every criterion before saving.</p>
      ) : null}
      {save.error ? <p className="text-danger" role="alert">{save.error.message}</p> : null}
      <div className={toolbarClass}>
        {stageCompleted ? (
          <ConfirmButton
            label="Save Changes"
            confirmLabel="Save Anyway"
            warning={`The ${stageTitles[stage] ?? stage} stage is already complete. Changing this decision may affect results that have already been finalized.`}
            onConfirm={() => save.mutate()}
            disabled={save.isPending || !criteriaComplete}
          />
        ) : (
          <Button type="button" onClick={() => save.mutate()} disabled={save.isPending || !criteriaComplete}>
            Save Changes
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
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

type DecisionSortKey = 'title' | 'authors' | 'venue' | 'decision' | 'doi' | 'submitted'
type SortDirection = 'asc' | 'desc'

function itemStatus(item: MyDecisionItem): string {
  return item.decision?.outcome ?? item.retrievalStatus ?? ''
}

function itemStatusLabel(item: MyDecisionItem): string {
  if (item.decision) return outcomeLabels[item.decision.outcome] ?? item.decision.outcome
  return retrievalStatusLabels[item.retrievalStatus ?? ''] ?? item.retrievalStatus ?? 'Retrieval resolved'
}

function decisionSortValue(item: MyDecisionItem, key: DecisionSortKey): string | number {
  switch (key) {
    case 'title':
      return item.publication.title.toLocaleLowerCase()
    case 'authors':
      return (item.publication.authors ?? '').toLocaleLowerCase()
    case 'venue':
      return (item.publication.venue ?? '').toLocaleLowerCase()
    case 'decision':
      return itemStatusLabel(item).toLocaleLowerCase()
    case 'doi':
      return (item.publication.doi ?? '').toLocaleLowerCase()
    case 'submitted':
      return item.submittedAt ? Date.parse(item.submittedAt) : 0
    default:
      return ''
  }
}

function sortDecisionItems(
  items: MyDecisionItem[],
  key: DecisionSortKey,
  direction: SortDirection,
): MyDecisionItem[] {
  return [...items].sort((left, right) => {
    const leftValue = decisionSortValue(left, key)
    const rightValue = decisionSortValue(right, key)
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base' })
    if (comparison !== 0) return direction === 'asc' ? comparison : -comparison
    return left.publication.title.localeCompare(right.publication.title)
  })
}

function formatSubmittedAt(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function DecisionRow({
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
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const publication = item.publication
  const decision = item.decision
  const detailHref = `/projects/${projectId}/publications/${publication.id}`

  const openPublication = (event: MouseEvent<HTMLLIElement>) => {
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label, [data-decision-editor]')) return
    navigate(detailHref)
  }

  return (
    <li className="cursor-pointer overflow-hidden rounded-lg border border-border bg-surface shadow-sm transition-colors hover:border-border-strong" onClick={openPublication}>
      <div className="grid grid-cols-1 items-center gap-x-4 gap-y-2 p-4 min-[861px]:grid-cols-[minmax(14rem,2fr)_minmax(8rem,1fr)_minmax(8rem,auto)_minmax(8rem,auto)_minmax(8rem,auto)_auto]">
        <div className="min-w-0">
          <Link className="block text-inherit no-underline hover:text-primary" to={detailHref}>
            <h2 className="m-0 text-base leading-snug">
              <HighlightedText text={publication.title} keywords={highlightKeywords} />
            </h2>
          </Link>
          <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm text-text-muted">
            {publication.authors ?? 'Unknown authors'}
          </div>
        </div>
        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-text-muted" title={publication.venue ?? undefined}>
          {publication.venue ?? '—'}
        </span>
        <span>
          <OutcomeBadge
            outcome={decision?.outcome ?? 'exclude'}
            label={decision && decision.version > 1 ? `${itemStatusLabel(item)} · v${decision.version}` : itemStatusLabel(item)}
          />
        </span>
        <span>
          {publication.doi ? <DoiPill doi={publication.doi} /> : <span className="text-text-muted">—</span>}
        </span>
        <time className="overflow-hidden text-ellipsis whitespace-nowrap text-sm text-text-muted" dateTime={item.submittedAt ?? undefined}>
          {formatSubmittedAt(item.submittedAt)}
        </time>
        <span className="flex justify-start min-[861px]:justify-end">
          {!editing && decision ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
              Edit Decision
            </Button>
          ) : null}
        </span>
      </div>
      {editing && decision ? (
        <div className="border-t border-border bg-bg-elevated p-4" data-decision-editor>
          <DecisionEditForm
            projectId={projectId}
            stage={stage}
            item={item}
            criteria={criteria}
            stageCompleted={stageCompleted}
            onDone={() => setEditing(false)}
            onWorkflowImpact={onWorkflowImpact}
          />
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
  const [sortKey, setSortKey] = useState<DecisionSortKey>('submitted')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
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
    return sortDecisionItems(items, sortKey, sortDirection)
  }, [query.data?.items, search, sortDirection, sortKey, statusFilter])

  return (
    <Page>
      <StageEyebrow
        stage={stage === 'full_text' ? 'full_text_screening' : 'title_abstract_screening'}
      />
      <h1>My {stageTitles[stage] ?? stage} Decisions</h1>
      <p className="text-text-muted">
        Decisions you have already submitted for this stage. Open one to review or revise it.
      </p>
      <p>
        <Link to={stage === 'full_text' ? `/projects/${projectId}/full-text` : `/projects/${projectId}/screening/${stage}`}>
          ← Back to screening queue
        </Link>
      </p>
      {query.error ? <p className="text-danger" role="alert">{query.error.message}</p> : null}
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
            <section className="text-danger rounded-md border border-danger/30 bg-danger-container p-4" role="alert" aria-labelledby="revision-impact-heading">
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
              <CountPill count={search || statusFilter ? filteredItems.length : query.data.items.length}>
                {search || statusFilter
                  ? `of ${query.data.items.length} decisions match your filters`
                  : `decision${query.data.items.length === 1 ? '' : 's'}`}
              </CountPill>
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid min-w-[min(20rem,100%)] flex-1 gap-1 text-sm font-semibold text-text-secondary">
                  Search papers
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Title, author, DOI, note…"
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-text-secondary">
                  Decision
                  <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                    {decisionFilterOptions
                      .filter((option) => !option.fullTextOnly || stage === 'full_text')
                      .map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </label>
                <label className="grid gap-1 text-sm font-semibold text-text-secondary">
                  Sort by
                  <Select
                    value={`${sortKey}:${sortDirection}`}
                    onChange={(event) => {
                      const [key, direction] = event.target.value.split(':') as [DecisionSortKey, SortDirection]
                      setSortKey(key)
                      setSortDirection(direction)
                    }}
                  >
                    <option value="submitted:desc">Newest submission</option>
                    <option value="submitted:asc">Oldest submission</option>
                    <option value="title:asc">Title A–Z</option>
                    <option value="title:desc">Title Z–A</option>
                    <option value="authors:asc">Authors A–Z</option>
                    <option value="authors:desc">Authors Z–A</option>
                    <option value="venue:asc">Venue A–Z</option>
                    <option value="venue:desc">Venue Z–A</option>
                    <option value="decision:asc">Decision A–Z</option>
                    <option value="decision:desc">Decision Z–A</option>
                  </Select>
                </label>
              </div>
            </>
          ) : null}
          {query.data.items.length === 0 ? (
            <p className="text-text-muted">You have not submitted any decisions for this stage yet.</p>
          ) : filteredItems.length === 0 ? (
            <p className="text-text-muted">No decisions match your filters.</p>
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0" aria-label="Submitted decisions">
                {filteredItems.map((item) => (
                  <DecisionRow
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
    </Page>
  )
}
