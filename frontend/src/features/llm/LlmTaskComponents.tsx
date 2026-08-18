import { useEffect, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { IconRestart } from '../../components/icons'
import { criterionNumbers, criterionOrderIndex } from '../screening/criteriaNumbering'
import type { CriterionAnswer, ScreeningCriterion } from '../screening/useScreeningQueue'

export interface LlmEvidenceItem {
  page: number
  quote: string
  section: string | null
  verified: boolean
}

interface CriterionSuggestion {
  criterionId: string | null
  criterionText: string
  criterionKind: string
  assessment: 'met' | 'not_met' | 'unclear'
  explanation: string
  evidence: LlmEvidenceItem[]
  evidenceValidationStatus: string
}

interface ScreeningAssistance {
  state: string
  hidden: boolean
  runId: string | null
  documentId: string | null
  model: string | null
  promptVersion: string | null
  stale: boolean
  error: string | null
  suggestedDecision: 'include' | 'exclude' | 'uncertain' | null
  confidence: 'low' | 'medium' | 'high' | null
  reasoningSummary: string | null
  criteria: CriterionSuggestion[]
}

export function LlmEvidence({
  evidence,
  projectId,
  publicationId,
}: {
  evidence: LlmEvidenceItem[]
  projectId: string
  publicationId: string
}) {
  if (!evidence.length) return <p className="muted">No source evidence returned.</p>
  return (
    <div className="llm-evidence-list">
      {evidence.map((item, index) => (
        <blockquote key={`${item.page}-${index}`}>
          <p>
            Page {item.page}
            {item.section ? ` · ${item.section}` : ''}
            {' · '}{item.verified ? 'Verified evidence' : 'Unverified evidence'}
          </p>
          <q>{item.quote}</q>
          <p>
            <a
              href={`/api/v1/projects/${projectId}/publications/${publicationId}/full-text/content#page=${item.page}`}
              target="_blank"
              rel="noreferrer"
            >
              Open PDF at page {item.page}
            </a>
          </p>
        </blockquote>
      ))}
    </div>
  )
}

function statusText(state: string) {
  return state.replaceAll('_', ' ')
}

function criterionComparison(
  assessment: string,
  humanAnswer: CriterionAnswer | undefined,
): 'match' | 'mismatch' | null {
  if (humanAnswer === undefined || humanAnswer === null || assessment === 'unclear') return null
  return (assessment === 'met') === humanAnswer ? 'match' : 'mismatch'
}

export function LlmAssistanceHeading({ qualifier }: { qualifier?: string }) {
  return (
    <h3>
      <span className="llm-task-panel__icon" aria-hidden="true">✦</span>
      {' '}LLM assistance{qualifier ? ` ${qualifier}` : ''}
    </h3>
  )
}

export function ScreeningLlmPanel({
  projectId,
  publicationId,
  itemId,
  stage,
  humanDecision,
  criteriaAnswers,
  criteria = [],
}: {
  projectId: string
  publicationId: string
  itemId: string
  stage: 'title_abstract' | 'full_text'
  humanDecision?: string
  criteriaAnswers?: Record<string, CriterionAnswer>
  criteria?: ScreeningCriterion[]
}) {
  const numbers = criterionNumbers(criteria)
  const orderIndex = criterionOrderIndex(criteria)
  const suffix = stage === 'title_abstract' ? 'llm-title-abstract' : 'llm-full-text'
  const endpoint = `/api/v1/projects/${projectId}/screening/work-items/${itemId}/${suffix}`
  const query = useQuery({
    queryKey: ['screening-llm', projectId, itemId, stage, Boolean(humanDecision)],
    queryFn: () => apiRequest<ScreeningAssistance>(endpoint),
    refetchInterval: (current) => (
      ['queued', 'pending', 'processing'].includes(current.state.data?.state ?? '')
        ? 5000
        : false
    ),
  })
  const regenerate = useMutation({
    mutationFn: () => apiRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify({ force: true }),
    }),
    onSuccess: () => query.refetch(),
  })
  const data = query.data
  const headingRef = useRef<HTMLDivElement>(null)
  const scrolledResultRef = useRef<string | null>(null)
  useEffect(() => {
    if (
      stage !== 'title_abstract'
      || !humanDecision
      || data?.hidden
      || data?.state !== 'ready'
    ) return
    const resultKey = `${itemId}:${data.runId ?? 'ready'}`
    if (scrolledResultRef.current === resultKey) return
    scrolledResultRef.current = resultKey
    headingRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [data?.hidden, data?.runId, data?.state, humanDecision, itemId, stage])

  if (query.isLoading) {
    return (
      <aside className="llm-task-panel" aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p>Checking LLM assistance…</p>
      </aside>
    )
  }
  if (query.error) {
    return (
      <aside className="llm-task-panel" aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p className="error">{query.error.message}</p>
      </aside>
    )
  }
  if (!data?.state) return null
  if (data.hidden) {
    return (
      <aside className="llm-task-panel" aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p className="muted">Hidden until you submit your own screening decision.</p>
      </aside>
    )
  }
  if (data.state === 'disabled') return null
  if (['queued', 'pending', 'processing'].includes(data.state)) {
    return (
      <aside className="llm-task-panel" aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p>LLM processing: {statusText(data.state)}…</p>
      </aside>
    )
  }
  if (['missing_pdf', 'text_unavailable', 'unavailable'].includes(data.state)) {
    return (
      <aside className="llm-task-panel" aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p className="muted">
          {data.state === 'missing_pdf'
            ? 'Unavailable because no PDF is attached.'
            : data.error ?? 'Usable full text is not available yet.'}
        </p>
        <button type="button" className="button-secondary" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Try again
        </button>
      </aside>
    )
  }
  if (data.state === 'failed') {
    return (
      <aside className="llm-task-panel" aria-label="LLM assistance failed">
        <LlmAssistanceHeading qualifier="failed" />
        <p className="error">{data.error ?? 'The model did not return a usable result.'}</p>
        <button type="button" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>Retry</button>
      </aside>
    )
  }
  if (data.state === 'stale') {
    return (
      <aside className="llm-task-panel" aria-label="LLM assistance is stale">
        <LlmAssistanceHeading qualifier="is stale" />
        <p className="muted">The source changed before this result completed.</p>
        <button type="button" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          <IconRestart />
          Regenerate
        </button>
      </aside>
    )
  }
  const comparison = stage === 'title_abstract' && humanDecision && data.suggestedDecision
    ? humanDecision === data.suggestedDecision ? 'match' : 'mismatch'
    : null
  return (
    <aside
      className={`llm-task-panel${comparison ? ` llm-task-panel--${comparison}` : ''}`}
      aria-label={comparison === 'match'
        ? 'LLM assistance — matches your decision'
        : comparison === 'mismatch'
          ? 'LLM assistance — differs from your decision'
          : 'LLM assistance'}
    >
      <div ref={headingRef} className="llm-task-panel__heading">
        <LlmAssistanceHeading />
        <button type="button" className="button-secondary" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Regenerate
        </button>
      </div>
      {data.stale ? <p className="error">This result is stale. Regenerate it before relying on it.</p> : null}
      {humanDecision ? <p><strong>Your decision:</strong> {humanDecision}</p> : null}
      <p>
        <strong>LLM suggestion:</strong> {data.suggestedDecision ?? 'uncertain'}
        {data.confidence ? ` · ${data.confidence} confidence` : ''}
      </p>
      {data.reasoningSummary ? <p>{data.reasoningSummary}</p> : null}
      {[...(data.criteria ?? [])]
        .sort((a, b) => {
          const aIndex = a.criterionId ? orderIndex[a.criterionId] : undefined
          const bIndex = b.criterionId ? orderIndex[b.criterionId] : undefined
          if (aIndex === undefined && bIndex === undefined) return 0
          if (aIndex === undefined) return 1
          if (bIndex === undefined) return -1
          return aIndex - bIndex
        })
        .map((criterion) => {
        const comparison = criterion.criterionId
          ? criterionComparison(criterion.assessment, criteriaAnswers?.[criterion.criterionId])
          : null
        return (
          <details
            key={criterion.criterionId ?? criterion.criterionText}
            open={stage === 'full_text'}
            className={comparison ? `llm-criterion llm-criterion--${comparison}` : 'llm-criterion'}
          >
            <summary>
              {criterion.criterionId && numbers[criterion.criterionId] ? (
                <span className={`criterion-badge criterion-badge--${criterion.criterionKind}`}>
                  {numbers[criterion.criterionId]}
                </span>
              ) : null}
              <span className="llm-criterion__title">{criterion.criterionText}</span>
              <span className="llm-criterion__status"> · {statusText(criterion.assessment)}</span>
              {comparison === 'mismatch' ? (
                <span className="llm-criterion__flag"> ⚠ Differs from your answer</span>
              ) : null}
            </summary>
            <p>{criterion.explanation}</p>
            {stage === 'full_text' ? (
              <LlmEvidence
                evidence={criterion.evidence}
                projectId={projectId}
                publicationId={publicationId}
              />
            ) : null}
          </details>
        )
      })}
    </aside>
  )
}
