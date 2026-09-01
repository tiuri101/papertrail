import { useEffect, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { IconRestart } from '../../components/icons'
import { llmPanelClass, llmPanelHeadingClass, llmPanelToneClass } from './llmStyles'
import type { CriterionAnswer } from '../screening/useScreeningQueue'

export interface LlmEvidenceItem {
  page: number
  quote: string
  section: string | null
  verified: boolean
}

export interface CriterionSuggestion {
  criterionId: string | null
  criterionText: string
  criterionKind: string
  assessment: 'met' | 'not_met' | 'unclear'
  explanation: string
  evidence: LlmEvidenceItem[]
  evidenceValidationStatus: string
}

export interface ScreeningAssistance {
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
  if (!evidence.length) return <p className="text-text-muted">No source evidence returned.</p>
  return (
    <div className="grid gap-3">
      {evidence.map((item, index) => (
        <blockquote className="m-0 rounded-md border border-border bg-bg-elevated px-4 py-3" key={`${item.page}-${index}`}>
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

export function statusText(state: string) {
  return state.replaceAll('_', ' ')
}

/**
 * How a single criterion's LLM assessment relates to the reviewer's own
 * answer for that criterion — used to color/annotate the criteria table
 * once the suggestion is revealed. `null` means there's nothing to compare
 * (the reviewer hasn't answered yet, or the model itself was unclear).
 */
export function criterionComparison(
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

/**
 * Fetches (and can regenerate) the LLM screening suggestion for one work
 * item. Shared by the criteria table (per-criterion coloring/explanations)
 * and `ScreeningLlmPanel` (the overall summary) so both read the exact same
 * result — callers pass this hook's return value into both.
 */
export function useScreeningLlmAssistance({
  projectId,
  itemId,
  stage,
  humanDecision,
}: {
  projectId: string
  itemId: string
  stage: 'title_abstract' | 'full_text'
  humanDecision?: string
}) {
  const suffix = stage === 'title_abstract' ? 'llm-title-abstract' : 'llm-full-text'
  const endpoint = `/api/v1/projects/${projectId}/screening/work-items/${itemId}/${suffix}`
  const query = useQuery({
    queryKey: ['screening-llm', projectId, itemId, stage, Boolean(humanDecision)],
    queryFn: () => apiRequest<ScreeningAssistance>(endpoint),
    enabled: Boolean(projectId && itemId),
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
  return { query, regenerate }
}

export type ScreeningLlmAssistance = ReturnType<typeof useScreeningLlmAssistance>

/**
 * The overall summary panel: loading/error/hidden/disabled/processing/
 * failed/stale states, and — once ready — the suggested decision,
 * confidence, reasoning, and a regenerate button. Per-criterion detail
 * (assessment, explanation, evidence, apply-suggestion) lives in the
 * criteria table itself (see CriteriaAnswerFields), which reads the same
 * `assistance` result so both stay in sync.
 */
export function ScreeningLlmPanel({
  itemId,
  stage,
  humanDecision,
  assistance,
}: {
  itemId: string
  stage: 'title_abstract' | 'full_text'
  humanDecision?: string
  assistance: ScreeningLlmAssistance
}) {
  const { query, regenerate } = assistance
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
        <p className="text-danger">{query.error.message}</p>
      </aside>
    )
  }
  if (!data?.state) return null
  if (data.hidden) {
    return (
      <aside className={llmPanelClass} aria-label="LLM assistance">
        <LlmAssistanceHeading />
        <p className="text-text-muted">Hidden until you submit your own screening decision.</p>
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
        <p className="text-text-muted">
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
        <p className="text-danger">{data.error ?? 'The model did not return a usable result.'}</p>
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
        <p className="text-text-muted">The source changed before this result completed.</p>
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
      {data.stale ? <p className="text-danger">This result is stale. Regenerate it before relying on it.</p> : null}
      {humanDecision ? <p><strong>Your decision:</strong> {humanDecision}</p> : null}
      <p>
        <strong>LLM suggestion:</strong> {data.suggestedDecision ?? 'uncertain'}
        {data.confidence ? ` · ${data.confidence} confidence` : ''}
      </p>
      {data.reasoningSummary ? <p>{data.reasoningSummary}</p> : null}
      {data.criteria.length ? (
        <p className="text-text-muted">See the criteria table above for a per-criterion breakdown.</p>
      ) : null}
    </aside>
  )
}
