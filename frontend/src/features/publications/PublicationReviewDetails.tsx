import { toolbarClass } from '../../components/layoutStyles'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { CriterionBadge } from '../../components/CriterionBadge'
import { IconCheckCircle } from '../../components/icons'
import { Input } from '../../components/Input'
import { OutcomeBadge } from '../../components/OutcomeBadge'
import { Select } from '../../components/Select'
import { Textarea } from '../../components/Textarea'
import { DynamicForm, type DynamicFormField } from '../forms/DynamicForm'

interface FinalDecision {
  outcome: string
  resolutionMethod: string
  note: string | null
  resolvedBy: string | null
  resolvedAt: string | null
}

interface ReviewerDecision {
  workItemId: string
  reviewerName: string
  outcome: string
  criteriaAnswers: Record<string, boolean>
  notes: string | null
  version: number
  createdAt: string
}

interface ScreeningCriterion {
  id: string
  kind: 'inclusion' | 'exclusion'
  text: string
}

interface ScreeningDetails {
  finalDecision: FinalDecision | null
  criteria: ScreeningCriterion[]
  reviewerDecisions: ReviewerDecision[]
}

interface ExtractionResponseDetails {
  id: string
  version: number
  reviewerName: string | null
  answers: Record<string, unknown>
  fields: DynamicFormField[]
}

interface ExtractionDetails {
  workItemId: string
  status: string
  completedAt: string | null
  response: ExtractionResponseDetails | null
}

interface ReviewDetails {
  screening: {
    titleAbstract: ScreeningDetails | null
    fullText: ScreeningDetails | null
  }
  extraction: ExtractionDetails | null
}

const OUTCOMES = ['include', 'exclude', 'uncertain', 'duplicate']
const OUTCOME_LABELS: Record<string, string> = {
  include: 'Included',
  exclude: 'Excluded',
  uncertain: 'Uncertain',
  duplicate: 'Duplicate',
}

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.replaceAll('_', ' ')
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null
  return new Date(value).toLocaleString()
}

function valueLabel(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function numberedCriteria(criteria: ScreeningCriterion[]) {
  const counts = { inclusion: 0, exclusion: 0 }
  return [...criteria]
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'inclusion' ? -1 : 1))
    .map((criterion) => {
      counts[criterion.kind] += 1
      return {
        ...criterion,
        number: `${criterion.kind === 'inclusion' ? 'IC' : 'EC'}${counts[criterion.kind]}`,
      }
    })
}

function ScreeningResponseForm({
  criteria,
  decision,
  label,
  canManage,
  onOverride,
}: {
  criteria: ScreeningCriterion[]
  decision: ReviewerDecision
  label: string
  canManage: boolean
  onOverride: () => void
}) {
  const responseCriteria = criteria.filter((criterion) => criterion.id in decision.criteriaAnswers)
  return (
    <div className="overflow-x-auto border-t border-border pt-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong>{decision.reviewerName} <span className="text-text-muted">(v{decision.version})</span></strong>
        <OutcomeBadge outcome={decision.outcome} label={outcomeLabel(decision.outcome)} />
      </div>
      {formatDate(decision.createdAt) ? (
        <p className="text-text-muted my-1 text-[0.8rem]">Decided {formatDate(decision.createdAt)}</p>
      ) : null}
      <table className="m-0 w-full text-[0.82rem] [&_td]:px-[7px] [&_td]:py-[5px] [&_td]:text-center [&_th]:px-[7px] [&_th]:py-[5px] [&_th:not(:first-child)]:text-center [&_th:first-child]:min-w-64 [&_th:first-child]:text-left">
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col">Fulfilled</th>
            <th scope="col">Not fulfilled</th>
          </tr>
        </thead>
        <tbody>
          {numberedCriteria(responseCriteria).map((criterion) => {
            const answer = decision.criteriaAnswers[criterion.id]
            return (
              <tr key={criterion.id}>
                <th scope="row">
                  <CriterionBadge kind={criterion.kind} className="mr-2">
                    {criterion.number}
                  </CriterionBadge>
                  {criterion.text}
                </th>
                <td aria-label={`${criterion.number}: Fulfilled`}>
                  {answer === true ? (
                    <span className="inline-flex min-w-[2.2rem] items-center justify-center rounded-full border border-current bg-success-container px-[7px] py-0.5 text-[0.72rem] font-extrabold text-success">Yes</span>
                  ) : null}
                </td>
                <td aria-label={`${criterion.number}: Not fulfilled`}>
                  {answer === false ? (
                    <span className="inline-flex min-w-[2.2rem] items-center justify-center rounded-full border border-current bg-danger-container px-[7px] py-0.5 text-[0.72rem] font-extrabold text-danger">Yes</span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mb-0 mt-2">
        <strong>Notes:</strong> {decision.notes || 'None'}
      </p>
      {canManage ? (
        <Button type="button" variant="secondary" size="sm" onClick={onOverride}>
          Override {label}
        </Button>
      ) : null}
    </div>
  )
}

export function PublicationReviewDetails({
  projectId,
  publicationId,
  canManage,
}: {
  projectId: string
  publicationId: string
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const [responseOverride, setResponseOverride] = useState<{
    stageLabel: string
    workItemId: string
    reviewerName: string
    criteria: ScreeningCriterion[]
    criteriaAnswers: Record<string, boolean>
    outcome: string
    notes: string
    reason: string
  } | null>(null)
  const [editingExtraction, setEditingExtraction] = useState(false)
  const [extractionAnswers, setExtractionAnswers] = useState<Record<string, unknown>>({})
  const [extractionReason, setExtractionReason] = useState('')
  const details = useQuery({
    queryKey: ['publication-review-details', projectId, publicationId],
    queryFn: () => apiRequest<ReviewDetails>(
      `/api/v1/projects/${projectId}/publications/${publicationId}/review-details`,
    ),
    enabled: Boolean(projectId && publicationId),
  })

  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: ['publication-review-details', projectId, publicationId],
    })
    await queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    await queryClient.invalidateQueries({ queryKey: ['audit', projectId] })
  }
  const overrideScreeningResponse = useMutation({
    mutationFn: (override: NonNullable<typeof responseOverride>) => apiRequest(
      `/api/v1/projects/${projectId}/screening/work-items/${override.workItemId}/override`,
      {
        method: 'POST',
        body: JSON.stringify({
          outcome: override.outcome,
          criteriaAnswers: override.criteriaAnswers,
          notes: override.notes.trim() || null,
          reason: override.reason.trim(),
        }),
      },
    ),
    onSuccess: async () => {
      setResponseOverride(null)
      await refresh()
    },
  })
  const overrideExtraction = useMutation({
    mutationFn: () => {
      const item = details.data?.extraction
      if (!item) throw new Error('No extraction is available to override')
      return apiRequest(
        `/api/v1/projects/${projectId}/extraction/${item.workItemId}/override`,
        {
          method: 'POST',
          body: JSON.stringify({
            answers: extractionAnswers,
            reason: extractionReason.trim(),
          }),
        },
      )
    },
    onSuccess: async () => {
      setEditingExtraction(false)
      setExtractionReason('')
      await refresh()
    },
  })

  const renderScreeningStage = (
    stage: 'title_abstract' | 'full_text',
    label: string,
    stageDetails: ScreeningDetails | null,
  ) => {
    if (!stageDetails) return null
    const final = stageDetails.finalDecision
    const criteria = stageDetails.criteria ?? []
    const reviewerDecisions = stageDetails.reviewerDecisions ?? []
    return (
      <section className="rounded-sm border border-border bg-[color-mix(in_srgb,var(--color-surface-hover)_55%,transparent)] p-3" key={stage}>
        <div className="flex items-center justify-between gap-2">
          <h4>{label}</h4>
          {final ? <OutcomeBadge outcome={final.outcome} label={outcomeLabel(final.outcome)} /> : null}
        </div>
        {final ? (
          <p className="text-text-muted my-1 text-[0.8rem]">
            Final via {final.resolutionMethod.replaceAll('_', ' ')}
            {final.resolvedBy ? ` by ${final.resolvedBy}` : ''}
            {formatDate(final.resolvedAt) ? ` on ${formatDate(final.resolvedAt)}` : ''}
            {final.note ? ` — ${final.note}` : ''}
          </p>
        ) : <p className="text-text-muted">No final decision yet.</p>}
        {reviewerDecisions.length ? (
          <div className="mb-2 mt-3 grid gap-2">
            {reviewerDecisions.map((decision, index) => (
              <ScreeningResponseForm
                key={`${decision.reviewerName}-${index}`}
                criteria={criteria}
                decision={decision}
                label={label}
                canManage={canManage}
                onOverride={() => setResponseOverride({
                  stageLabel: label,
                  workItemId: decision.workItemId,
                  reviewerName: decision.reviewerName,
                  criteria: criteria.filter(
                    (criterion) => criterion.id in decision.criteriaAnswers,
                  ),
                  criteriaAnswers: { ...decision.criteriaAnswers },
                  outcome: decision.outcome,
                  notes: decision.notes ?? '',
                  reason: '',
                })}
              />
            ))}
          </div>
        ) : null}
      </section>
    )
  }

  const extraction = details.data?.extraction
  const response = extraction?.response

  return (
    <div className="ml-0 mt-2 text-[0.86rem] text-text-secondary">
      <div className="mt-2 grid gap-3 border-t border-border pt-3">
        {details.isLoading ? <p className="text-text-muted">Loading review details…</p> : null}
        {details.error ? <p className="text-danger" role="alert">{details.error.message}</p> : null}
        {details.data ? (
          <>
            <div className="grid grid-cols-1 gap-3">
              {renderScreeningStage(
                'title_abstract',
                'Title/Abstract',
                details.data.screening.titleAbstract,
              )}
              {renderScreeningStage('full_text', 'Full text', details.data.screening.fullText)}
            </div>
            {!details.data.screening.titleAbstract && !details.data.screening.fullText ? (
              <p className="text-text-muted">No screening decisions have been recorded.</p>
            ) : null}

            {extraction ? (
              <section className="rounded-sm border border-border bg-[color-mix(in_srgb,var(--color-surface-hover)_55%,transparent)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4>Data extraction</h4>
                  <Badge variant="plain">{extraction.status.replaceAll('_', ' ')}</Badge>
                </div>
                {response ? (
                  <>
                    <p className="text-text-muted my-1 text-[0.8rem]">
                      Version {response.version}{response.reviewerName ? ` by ${response.reviewerName}` : ''}
                      {formatDate(extraction.completedAt) ? ` on ${formatDate(extraction.completedAt)}` : ''}
                    </p>
                    <dl className="my-2 grid grid-cols-1 gap-x-4 min-[681px]:grid-cols-2">
                      {response.fields.map((field) => (
                        <div className="flex justify-between gap-2 border-b border-border py-1" key={field.stableKey}>
                          <dt className="text-text-muted">{field.label}</dt>
                          <dd className="m-0 text-right font-semibold text-text">{valueLabel(response.answers[field.stableKey])}</dd>
                        </div>
                      ))}
                    </dl>
                    {canManage ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setExtractionAnswers({ ...response.answers })
                          setExtractionReason('')
                          setEditingExtraction(true)
                        }}
                      >
                        Override data extraction
                      </Button>
                    ) : null}
                  </>
                ) : <p className="text-text-muted">No completed data extraction is available.</p>}
              </section>
            ) : null}

            {responseOverride ? (
              <form
                className="grid gap-3 overflow-x-auto rounded-sm border border-[color-mix(in_srgb,var(--color-primary)_30%,var(--color-border))] bg-primary-container p-3 [&_h4]:m-0 [&_input[type=radio]]:accent-primary"
                onSubmit={(event) => {
                  event.preventDefault()
                  overrideScreeningResponse.mutate(responseOverride)
                }}
              >
                <h4>Override {responseOverride.stageLabel}</h4>
                <p className="text-text-muted">
                  Editing the response submitted by {responseOverride.reviewerName}. The previous
                  version will remain in the audit history.
                </p>
                <table className="m-0 w-full text-[0.82rem] [&_td]:px-[7px] [&_td]:py-[5px] [&_td]:text-center [&_th]:px-[7px] [&_th]:py-[5px] [&_th:not(:first-child)]:text-center [&_th:first-child]:min-w-64 [&_th:first-child]:text-left">
                  <thead>
                    <tr>
                      <th scope="col">Criterion</th>
                      <th scope="col">Fulfilled</th>
                      <th scope="col">Not fulfilled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {numberedCriteria(responseOverride.criteria).map((criterion) => (
                      <tr key={criterion.id}>
                        <th scope="row">
                          <CriterionBadge kind={criterion.kind} className="mr-2">
                            {criterion.number}
                          </CriterionBadge>
                          {criterion.text}
                        </th>
                        <td>
                          <Input
                            type="radio"
                            name={`criterion-${criterion.id}`}
                            aria-label={`${criterion.number}: Set fulfilled`}
                            checked={responseOverride.criteriaAnswers[criterion.id] === true}
                            onChange={() => setResponseOverride({
                              ...responseOverride,
                              criteriaAnswers: {
                                ...responseOverride.criteriaAnswers,
                                [criterion.id]: true,
                              },
                            })}
                          />
                        </td>
                        <td>
                          <Input
                            type="radio"
                            name={`criterion-${criterion.id}`}
                            aria-label={`${criterion.number}: Set not fulfilled`}
                            checked={responseOverride.criteriaAnswers[criterion.id] === false}
                            onChange={() => setResponseOverride({
                              ...responseOverride,
                              criteriaAnswers: {
                                ...responseOverride.criteriaAnswers,
                                [criterion.id]: false,
                              },
                            })}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <label>
                  Decision
                  <Select
                    value={responseOverride.outcome}
                    onChange={(event) => setResponseOverride({
                      ...responseOverride,
                      outcome: event.target.value,
                    })}
                  >
                    {OUTCOMES.map((outcome) => (
                      <option key={outcome} value={outcome}>{outcomeLabel(outcome)}</option>
                    ))}
                  </Select>
                </label>
                <label>
                  Notes
                  <Textarea
                    value={responseOverride.notes}
                    onChange={(event) => setResponseOverride({
                      ...responseOverride,
                      notes: event.target.value,
                    })}
                  />
                </label>
                <label>
                  Reason for override
                  <Textarea
                    value={responseOverride.reason}
                    onChange={(event) => setResponseOverride({
                      ...responseOverride,
                      reason: event.target.value,
                    })}
                    required
                  />
                </label>
                <div className={toolbarClass}>
                  <Button
                    type="submit"
                    disabled={overrideScreeningResponse.isPending || !responseOverride.reason.trim()}
                  >
                    <IconCheckCircle />
                    Save override
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setResponseOverride(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
            {overrideScreeningResponse.error ? (
              <p className="text-danger" role="alert">{overrideScreeningResponse.error.message}</p>
            ) : null}

            {editingExtraction && response ? (
              <form
                className="grid gap-3 overflow-x-auto rounded-sm border border-[color-mix(in_srgb,var(--color-primary)_30%,var(--color-border))] bg-primary-container p-3 [&_h4]:m-0"
                onSubmit={(event) => { event.preventDefault(); overrideExtraction.mutate() }}
              >
                <h4>Override data extraction</h4>
                <DynamicForm
                  fields={response.fields}
                  value={extractionAnswers}
                  onChange={(key, value) => setExtractionAnswers((current) => ({
                    ...current,
                    [key]: value,
                  }))}
                />
                <label>
                  Reason for override
                  <Textarea
                    value={extractionReason}
                    onChange={(event) => setExtractionReason(event.target.value)}
                    required
                  />
                </label>
                <div className={toolbarClass}>
                  <Button
                    type="submit"
                    disabled={overrideExtraction.isPending || !extractionReason.trim()}
                  >
                    <IconCheckCircle />
                    Save extraction override
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setEditingExtraction(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null}
            {overrideExtraction.error ? <p className="text-danger" role="alert">{overrideExtraction.error.message}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
