import { useEffect, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { IconRestart } from '../../components/icons'
import { cn } from '../../lib/cn'
import { llmPanelClass, llmPanelHeadingClass, llmPanelToneClass } from './llmStyles'
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
      <span className="text-primary" aria-hidden="true">✦</span>
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
  setCriteriaAnswers,
}: {
  projectId: string
  publicationId: string
  itemId: string
  stage: 'title_abstract' | 'full_text'
  humanDecision?: string
  criteriaAnswers?: Record<string, CriterionAnswer>
  criteria?: ScreeningCriterion[]
  setCriteriaAnswers?: (updater: (current: Record<string, CriterionAnswer>) => Record<string, CriterionAnswer>) => void
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
      <aside className={llmPanelClass} aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p>Checking LLM assistance…</p>
      </aside>
    )
  }
  if (query.error) {
    return (
      <aside className={llmPanelClass} aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p className="error">{query.error.message}</p>
      </aside>
    )
  }
  if (!data?.state) return null
  if (data.hidden) {
    return (
      <aside className={llmPanelClass} aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p className="muted">Hidden until you submit your own screening decision.</p>
      </aside>
    )
  }
  if (data.state === 'disabled') return null
  if (['queued', 'pending', 'processing'].includes(data.state)) {
    return (
      <aside className={llmPanelClass} aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p>LLM processing: {statusText(data.state)}…</p>
      </aside>
    )
  }
  if (['missing_pdf', 'text_unavailable', 'unavailable'].includes(data.state)) {
    return (
      <aside className={llmPanelClass} aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p className="muted">
          {data.state === 'missing_pdf'
            ? 'Unavailable because no PDF is attached.'
            : data.error ?? 'Usable full text is not available yet.'}
        </p>
        <Button type="button" variant="secondary" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Try again
        </Button>
      </aside>
    )
  }
  if (data.state === 'failed') {
    return (
      <aside className={llmPanelClass} aria-label="LLM assistance failed">
        <LlmAssistanceHeading qualifier="failed" />
        <p className="error">{data.error ?? 'The model did not return a usable result.'}</p>
        <Button type="button" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Retry
        </Button>
      </aside>
    )
  }
  if (data.state === 'stale') {
    return (
      <aside className={llmPanelClass} aria-label="LLM assistance is stale">
        <LlmAssistanceHeading qualifier="is stale" />
        <p className="muted">The source changed before this result completed.</p>
        <Button
          type="button"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
          startIcon={<IconRestart />}
        >
          Regenerate
        </Button>
      </aside>
    )
  }
  const comparison = stage === 'title_abstract' && humanDecision && data.suggestedDecision
    ? humanDecision === data.suggestedDecision ? 'match' : 'mismatch'
    : null
  return (
    <aside
      className={llmPanelToneClass(comparison ?? undefined)}
      data-comparison={comparison ?? undefined}
      aria-label={comparison === 'match'
        ? 'LLM assistance — matches your decision'
        : comparison === 'mismatch'
          ? 'LLM assistance — differs from your decision'
          : 'LLM assistance'}
    >
      <div ref={headingRef} className={llmPanelHeadingClass}>
        <LlmAssistanceHeading />
        <Button type="button" variant="secondary" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Regenerate
        </Button>
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
            className={cn(
              'group my-2 rounded-lg border border-transparent px-3 py-2 open:px-5 open:py-4',
              '[&_summary]:flex [&_summary]:cursor-pointer [&_summary]:list-none [&_summary]:flex-wrap [&_summary]:items-baseline [&_summary]:gap-1',
              '[&_summary]:after:ml-auto [&_summary]:after:shrink-0 [&_summary]:after:text-[1.35rem] [&_summary]:after:font-medium [&_summary]:after:leading-none [&_summary]:after:text-text-secondary [&_summary]:after:content-[\'+\'] open:[&_summary]:after:content-[\'−\']',
              'open:[&_summary]:-mx-3 open:[&_summary]:-mt-2 open:[&_summary]:mb-3 open:[&_summary]:border-b open:[&_summary]:border-[color-mix(in_srgb,currentColor_18%,transparent)] open:[&_summary]:px-4 open:[&_summary]:py-3 open:[&_summary]:text-base open:[&_summary]:font-bold open:[&_summary]:leading-snug open:[&_summary]:text-text',
              comparison === 'match' && 'border-success bg-success-container',
              comparison === 'mismatch' && 'border-danger bg-danger-container',
            )}
            data-comparison={comparison ?? undefined}
          >
            <summary>
              {criterion.criterionId && numbers[criterion.criterionId] ? (
                <span className={`criterion-badge criterion-badge--${criterion.criterionKind}`}>
                  {numbers[criterion.criterionId]}
                </span>
              ) : null}
              <span className="group-open:text-base group-open:font-bold group-open:tracking-[-0.01em] group-open:text-text">{criterion.criterionText}</span>
              <span className="group-open:text-[0.82rem] group-open:font-semibold group-open:text-text-secondary"> · {statusText(criterion.assessment)}</span>
              {comparison === 'mismatch' ? (
                <span className="font-semibold text-danger group-open:text-[0.82rem]"> ⚠ Differs from your answer</span>
              ) : null}
            </summary>
            <p>{criterion.explanation}</p>
            {comparison === 'mismatch' && setCriteriaAnswers && criterion.criterionId ? (
              <div className="toolbar">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    const criterionId = criterion.criterionId!
                    const met = criterion.assessment === 'met'
                    setCriteriaAnswers((current) => ({ ...current, [criterionId]: met }))
                  }}
                >
                  Apply suggestion
                </Button>
              </div>
            ) : null}
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
