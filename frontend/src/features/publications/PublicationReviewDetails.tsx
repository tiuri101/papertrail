import { tableBaseClass, toolbarClass } from '../../components/layoutStyles'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { CriterionBadge } from '../../components/CriterionBadge'
import { cn } from '../../lib/cn'
import { IconCheckCircle, IconXCircle } from '../../components/icons'
import { OutcomeBadge } from '../../components/OutcomeBadge'
import { Select } from '../../components/Select'
import { Textarea } from '../../components/Textarea'
import { DynamicForm, type DynamicFormField } from '../forms/DynamicForm'
import { FieldLabel } from '../../components/FieldLabel'

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

interface ExtractionSlot {
  slotNumber: number
  workItemId: string
  status: string
  completedAt: string | null
  response: ExtractionResponseDetails | null
}

interface ExtractionFinal {
  answers: Record<string, unknown>
  resolutionMethod: string
  resolvedAt: string | null
}

interface ExtractionDetails {
  requiredReviewers: number
  slots: ExtractionSlot[]
  final: ExtractionFinal | null
}

interface QualityResponseDetails {
  reviewerName: string | null
  answers: Record<string, unknown>
  totalScore: number | null
  version: number
  fields: DynamicFormField[]
}

interface QualityDetails {
  status: string
  completedAt: string | null
  response: QualityResponseDetails | null
}

interface ReviewDetails {
  screening: {
    titleAbstract: ScreeningDetails | null
    fullText: ScreeningDetails | null
  }
  extraction: ExtractionDetails | null
  quality: QualityDetails | null
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
      <table className={`${tableBaseClass} m-0 w-full text-[0.82rem] [&_td]:px-[7px]! [&_td]:py-[5px]! [&_td]:text-center! [&_th]:px-[7px]! [&_th]:py-[5px]! [&_th:not(:first-child)]:text-center! [&_th:first-child]:min-w-64 [&_th:first-child]:text-left`}>
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
                    <span className={cn(
                      'inline-flex min-w-[2.2rem] items-center justify-center rounded-full border border-current px-[7px] py-0.5 text-[0.72rem] font-extrabold',
                      // An inclusion criterion being fulfilled is a good sign; an exclusion
                      // criterion being fulfilled means the exclusion applies, arguing against
                      // inclusion — same color meanings as the live screening queue's checkboxes.
                      criterion.kind === 'exclusion' ? 'bg-danger-container text-danger' : 'bg-success-container text-success',
                    )}
                    >
                      Yes
                    </span>
                  ) : null}
                </td>
                <td aria-label={`${criterion.number}: Not fulfilled`}>
                  {answer === false ? (
                    <span className={cn(
                      'inline-flex min-w-[2.2rem] items-center justify-center rounded-full border border-current px-[7px] py-0.5 text-[0.72rem] font-extrabold',
                      criterion.kind === 'exclusion' ? 'bg-success-container text-success' : 'bg-danger-container text-danger',
                    )}
                    >
                      No
                    </span>
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
  const [extractionOverride, setExtractionOverride] = useState<{
    workItemId: string
    fields: DynamicFormField[]
    answers: Record<string, unknown>
    reason: string
  } | null>(null)
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
    mutationFn: (override: NonNullable<typeof extractionOverride>) => apiRequest(
      `/api/v1/projects/${projectId}/extraction/${override.workItemId}/override`,
      {
        method: 'POST',
        body: JSON.stringify({
          answers: override.answers,
          reason: override.reason.trim(),
        }),
      },
    ),
    onSuccess: async () => {
      setExtractionOverride(null)
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
  const quality = details.data?.quality
  const extractionFieldLabel = (stableKey: string): string => (
    extraction?.slots.find((slot) => slot.response?.fields.some((field) => field.stableKey === stableKey))
      ?.response?.fields.find((field) => field.stableKey === stableKey)?.label ?? stableKey
  )
  // The override endpoint targets one reviewer's work item, not the resolved final answer
  // directly. With the (typical) single-required-reviewer extraction this is unambiguous; the
  // first completed slot is used as the target either way.
  const overridableSlot = extraction?.slots.find((slot) => slot.response)

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

            {extraction?.final ? (
              <section className="rounded-sm border border-border bg-[color-mix(in_srgb,var(--color-surface-hover)_55%,transparent)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4>Data extraction</h4>
                  <Badge variant="plain">Final</Badge>
                </div>
                <p className="text-text-muted my-1 text-[0.8rem]">
                  Final via {extraction.final.resolutionMethod.replaceAll('_', ' ')}
                  {formatDate(extraction.final.resolvedAt) ? ` on ${formatDate(extraction.final.resolvedAt)}` : ''}
                </p>
                <dl className="my-2 grid grid-cols-1 gap-x-4 min-[681px]:grid-cols-2">
                  {Object.keys(extraction.final.answers).map((stableKey) => (
                    <div className="flex justify-between gap-2 border-b border-border py-1" key={stableKey}>
                      <dt className="text-text-muted">{extractionFieldLabel(stableKey)}</dt>
                      <dd className="m-0 text-right font-semibold text-text">{valueLabel(extraction.final!.answers[stableKey])}</dd>
                    </div>
                  ))}
                </dl>
                {canManage && overridableSlot ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setExtractionOverride({
                      workItemId: overridableSlot.workItemId,
                      fields: overridableSlot.response!.fields,
                      answers: { ...overridableSlot.response!.answers },
                      reason: '',
                    })}
                  >
                    Override data extraction
                  </Button>
                ) : null}
              </section>
            ) : extraction && extraction.slots.length > 0 ? (
              <p className="text-text-muted">Data extraction is in progress; no final result yet.</p>
            ) : extraction ? (
              <p className="text-text-muted">No completed data extraction is available.</p>
            ) : null}

            {quality?.response ? (
              <section className="rounded-sm border border-border bg-[color-mix(in_srgb,var(--color-surface-hover)_55%,transparent)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <h4>Quality assessment</h4>
                  {quality.response.totalScore != null ? (
                    <Badge variant="plain">Score: {quality.response.totalScore}</Badge>
                  ) : null}
                </div>
                <p className="text-text-muted my-1 text-[0.8rem]">
                  Assessed by {quality.response.reviewerName ?? 'Unknown reviewer'}
                  {formatDate(quality.completedAt) ? ` on ${formatDate(quality.completedAt)}` : ''}
                </p>
                <dl className="my-2 grid grid-cols-1 gap-x-4 min-[681px]:grid-cols-2">
                  {quality.response.fields.map((field) => (
                    <div className="flex justify-between gap-2 border-b border-border py-1" key={field.stableKey}>
                      <dt className="text-text-muted">{field.label}</dt>
                      <dd className="m-0 text-right font-semibold text-text">{valueLabel(quality.response!.answers[field.stableKey])}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : quality ? (
              <p className="text-text-muted">Quality assessment is in progress; no result yet.</p>
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
                <table className={`${tableBaseClass} m-0 w-full text-[0.82rem] [&_td]:px-[7px]! [&_td]:py-[5px]! [&_td]:text-center! [&_th]:px-[7px]! [&_th]:py-[5px]! [&_th:not(:first-child)]:text-center! [&_th:first-child]:min-w-64 [&_th:first-child]:text-left`}>
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
                          <button
                            type="button"
                            role="checkbox"
                            className={cn(
                              'inline-flex size-8 min-h-8 items-center justify-center rounded-md border border-border bg-none bg-bg-elevated p-0 text-text-muted shadow-none transition-colors hover:border-border-strong hover:bg-surface-hover [&_svg]:size-4 [&_svg]:fill-current',
                              criterion.kind === 'exclusion'
                                ? 'aria-checked:border-danger aria-checked:bg-danger-container aria-checked:text-danger'
                                : 'aria-checked:border-success aria-checked:bg-success-container aria-checked:text-success',
                            )}
                            aria-checked={responseOverride.criteriaAnswers[criterion.id] === true}
                            aria-label={`${criterion.number}: Set fulfilled`}
                            onClick={() => setResponseOverride({
                              ...responseOverride,
                              criteriaAnswers: {
                                ...responseOverride.criteriaAnswers,
                                [criterion.id]: true,
                              },
                            })}
                          >
                            {responseOverride.criteriaAnswers[criterion.id] === true ? <IconCheckCircle /> : null}
                          </button>
                        </td>
                        <td>
                          <button
                            type="button"
                            role="checkbox"
                            className={cn(
                              'inline-flex size-8 min-h-8 items-center justify-center rounded-md border border-border bg-none bg-bg-elevated p-0 text-text-muted shadow-none transition-colors hover:border-border-strong hover:bg-surface-hover [&_svg]:size-4 [&_svg]:fill-current',
                              criterion.kind === 'exclusion'
                                ? 'aria-checked:border-success aria-checked:bg-success-container aria-checked:text-success'
                                : 'aria-checked:border-danger aria-checked:bg-danger-container aria-checked:text-danger',
                            )}
                            aria-checked={responseOverride.criteriaAnswers[criterion.id] === false}
                            aria-label={`${criterion.number}: Set not fulfilled`}
                            onClick={() => setResponseOverride({
                              ...responseOverride,
                              criteriaAnswers: {
                                ...responseOverride.criteriaAnswers,
                                [criterion.id]: false,
                              },
                            })}
                          >
                            {responseOverride.criteriaAnswers[criterion.id] === false ? <IconXCircle /> : null}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <FieldLabel>
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
                </FieldLabel>
                <FieldLabel>
                  Notes
                  <Textarea
                    value={responseOverride.notes}
                    onChange={(event) => setResponseOverride({
                      ...responseOverride,
                      notes: event.target.value,
                    })}
                  />
                </FieldLabel>
                <FieldLabel>
                  Reason for override
                  <Textarea
                    value={responseOverride.reason}
                    onChange={(event) => setResponseOverride({
                      ...responseOverride,
                      reason: event.target.value,
                    })}
                    required
                  />
                </FieldLabel>
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

            {extractionOverride ? (
              <form
                className="grid gap-3 overflow-x-auto rounded-sm border border-[color-mix(in_srgb,var(--color-primary)_30%,var(--color-border))] bg-primary-container p-3 [&_h4]:m-0"
                onSubmit={(event) => {
                  event.preventDefault()
                  overrideExtraction.mutate(extractionOverride)
                }}
              >
                <h4>Override data extraction</h4>
                <DynamicForm
                  fields={extractionOverride.fields}
                  value={extractionOverride.answers}
                  onChange={(key, value) => setExtractionOverride((current) => (current ? {
                    ...current,
                    answers: { ...current.answers, [key]: value },
                  } : current))}
                />
                <FieldLabel>
                  Reason for override
                  <Textarea
                    value={extractionOverride.reason}
                    onChange={(event) => setExtractionOverride((current) => (current ? {
                      ...current,
                      reason: event.target.value,
                    } : current))}
                    required
                  />
                </FieldLabel>
                <div className={toolbarClass}>
                  <Button
                    type="submit"
                    disabled={overrideExtraction.isPending || !extractionOverride.reason.trim()}
                  >
                    <IconCheckCircle />
                    Save extraction override
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setExtractionOverride(null)}>
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
