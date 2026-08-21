import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { IconCheckCircle } from '../../components/icons'
import { OutcomeBadge } from '../../components/OutcomeBadge'
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
    <div className="publication-review-details__screening-form">
      <div className="publication-review-details__response-heading">
        <strong>{decision.reviewerName} <span className="muted">(v{decision.version})</span></strong>
        <OutcomeBadge outcome={decision.outcome} label={outcomeLabel(decision.outcome)} />
      </div>
      {formatDate(decision.createdAt) ? (
        <p className="muted publication-review-details__meta">Decided {formatDate(decision.createdAt)}</p>
      ) : null}
      <table className="criteria-table publication-review-details__criteria">
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
                  <span className={`criterion-badge criterion-badge--${criterion.kind}`}>
                    {criterion.number}
                  </span>{' '}
                  {criterion.text}
                </th>
                <td aria-label={`${criterion.number}: Fulfilled`}>
                  {answer === true ? (
                    <span className="criterion-response criterion-response--fulfilled">Yes</span>
                  ) : null}
                </td>
                <td aria-label={`${criterion.number}: Not fulfilled`}>
                  {answer === false ? (
                    <span className="criterion-response criterion-response--not-fulfilled">Yes</span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="publication-review-details__form-notes">
        <strong>Notes:</strong> {decision.notes || 'None'}
      </p>
      {canManage ? (
        <button type="button" className="button-secondary button-sm" onClick={onOverride}>
          Override {label}
        </button>
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
      <section className="publication-review-details__stage" key={stage}>
        <div className="publication-review-details__heading">
          <h4>{label}</h4>
          {final ? <OutcomeBadge outcome={final.outcome} label={outcomeLabel(final.outcome)} /> : null}
        </div>
        {final ? (
          <p className="muted publication-review-details__meta">
            Final via {final.resolutionMethod.replaceAll('_', ' ')}
            {final.resolvedBy ? ` by ${final.resolvedBy}` : ''}
            {formatDate(final.resolvedAt) ? ` on ${formatDate(final.resolvedAt)}` : ''}
            {final.note ? ` — ${final.note}` : ''}
          </p>
        ) : <p className="muted">No final decision yet.</p>}
        {reviewerDecisions.length ? (
          <div className="publication-review-details__responses">
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
    <div className="publication-review-details">
      <div className="publication-review-details__content">
        {details.isLoading ? <p className="muted">Loading review details…</p> : null}
        {details.error ? <p className="error" role="alert">{details.error.message}</p> : null}
        {details.data ? (
          <>
            <div className="publication-review-details__screening">
              {renderScreeningStage(
                'title_abstract',
                'Title/Abstract',
                details.data.screening.titleAbstract,
              )}
              {renderScreeningStage('full_text', 'Full text', details.data.screening.fullText)}
            </div>
            {!details.data.screening.titleAbstract && !details.data.screening.fullText ? (
              <p className="muted">No screening decisions have been recorded.</p>
            ) : null}

            {extraction ? (
              <section className="publication-review-details__extraction">
                <div className="publication-review-details__heading">
                  <h4>Data extraction</h4>
                  <span className="status-badge">{extraction.status.replaceAll('_', ' ')}</span>
                </div>
                {response ? (
                  <>
                    <p className="muted publication-review-details__meta">
                      Version {response.version}{response.reviewerName ? ` by ${response.reviewerName}` : ''}
                      {formatDate(extraction.completedAt) ? ` on ${formatDate(extraction.completedAt)}` : ''}
                    </p>
                    <dl className="publication-review-details__values">
                      {response.fields.map((field) => (
                        <div key={field.stableKey}>
                          <dt>{field.label}</dt>
                          <dd>{valueLabel(response.answers[field.stableKey])}</dd>
                        </div>
                      ))}
                    </dl>
                    {canManage ? (
                      <button
                        type="button"
                        className="button-secondary button-sm"
                        onClick={() => {
                          setExtractionAnswers({ ...response.answers })
                          setExtractionReason('')
                          setEditingExtraction(true)
                        }}
                      >
                        Override data extraction
                      </button>
                    ) : null}
                  </>
                ) : <p className="muted">No completed data extraction is available.</p>}
              </section>
            ) : null}

            {responseOverride ? (
              <form
                className="publication-review-details__override"
                onSubmit={(event) => {
                  event.preventDefault()
                  overrideScreeningResponse.mutate(responseOverride)
                }}
              >
                <h4>Override {responseOverride.stageLabel}</h4>
                <p className="muted">
                  Editing the response submitted by {responseOverride.reviewerName}. The previous
                  version will remain in the audit history.
                </p>
                <table className="criteria-table publication-review-details__criteria">
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
                          <span className={`criterion-badge criterion-badge--${criterion.kind}`}>
                            {criterion.number}
                          </span>{' '}
                          {criterion.text}
                        </th>
                        <td>
                          <input
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
                          <input
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
                  <select
                    value={responseOverride.outcome}
                    onChange={(event) => setResponseOverride({
                      ...responseOverride,
                      outcome: event.target.value,
                    })}
                  >
                    {OUTCOMES.map((outcome) => (
                      <option key={outcome} value={outcome}>{outcomeLabel(outcome)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Notes
                  <textarea
                    value={responseOverride.notes}
                    onChange={(event) => setResponseOverride({
                      ...responseOverride,
                      notes: event.target.value,
                    })}
                  />
                </label>
                <label>
                  Reason for override
                  <textarea
                    value={responseOverride.reason}
                    onChange={(event) => setResponseOverride({
                      ...responseOverride,
                      reason: event.target.value,
                    })}
                    required
                  />
                </label>
                <div className="toolbar">
                  <button
                    type="submit"
                    disabled={overrideScreeningResponse.isPending || !responseOverride.reason.trim()}
                  >
                    <IconCheckCircle />
                    Save override
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => setResponseOverride(null)}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
            {overrideScreeningResponse.error ? (
              <p className="error" role="alert">{overrideScreeningResponse.error.message}</p>
            ) : null}

            {editingExtraction && response ? (
              <form
                className="publication-review-details__override"
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
                  <textarea
                    value={extractionReason}
                    onChange={(event) => setExtractionReason(event.target.value)}
                    required
                  />
                </label>
                <div className="toolbar">
                  <button
                    type="submit"
                    disabled={overrideExtraction.isPending || !extractionReason.trim()}
                  >
                    <IconCheckCircle />
                    Save extraction override
                  </button>
                  <button type="button" className="button-secondary" onClick={() => setEditingExtraction(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : null}
            {overrideExtraction.error ? <p className="error" role="alert">{overrideExtraction.error.message}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
