import { useMutation, useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'

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

export function ScreeningLlmPanel({
  projectId,
  publicationId,
  itemId,
  stage,
  humanDecision,
}: {
  projectId: string
  publicationId: string
  itemId: string
  stage: 'title_abstract' | 'full_text'
  humanDecision?: string
}) {
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
  if (query.isLoading) return <aside className="llm-task-panel"><p>Checking LLM assistance…</p></aside>
  if (query.error) return <aside className="llm-task-panel"><p className="error">{query.error.message}</p></aside>
  if (!data?.state) return null
  if (data.hidden) {
    return (
      <aside className="llm-task-panel" aria-label="LLM suggestion">
        <h3>LLM suggestion</h3>
        <p className="muted">Hidden until you submit your own screening decision.</p>
      </aside>
    )
  }
  if (data.state === 'disabled') return null
  if (['queued', 'pending', 'processing'].includes(data.state)) {
    return <aside className="llm-task-panel"><h3>LLM assistance</h3><p>LLM processing: {statusText(data.state)}…</p></aside>
  }
  if (['missing_pdf', 'text_unavailable', 'unavailable'].includes(data.state)) {
    return (
      <aside className="llm-task-panel">
        <h3>LLM assistance</h3>
        <p className="muted">
          {data.state === 'missing_pdf'
            ? 'Unavailable because no PDF is attached.'
            : data.error ?? 'Usable full text is not available yet.'}
        </p>
        <button type="button" className="secondary" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Try again
        </button>
      </aside>
    )
  }
  if (data.state === 'failed') {
    return (
      <aside className="llm-task-panel">
        <h3>LLM assistance failed</h3>
        <p className="error">{data.error ?? 'The model did not return a usable result.'}</p>
        <button type="button" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>Retry</button>
      </aside>
    )
  }
  if (data.state === 'stale') {
    return (
      <aside className="llm-task-panel">
        <h3>LLM assistance is stale</h3>
        <p className="muted">The source changed before this result completed.</p>
        <button type="button" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Regenerate
        </button>
      </aside>
    )
  }
  const disagrees = Boolean(
    humanDecision
    && data.suggestedDecision
    && data.suggestedDecision !== 'uncertain'
    && humanDecision !== data.suggestedDecision,
  )
  return (
    <aside className="llm-task-panel" aria-label="LLM assistance">
      <div className="llm-task-panel__heading">
        <h3>✦ LLM assistance</h3>
        <button type="button" className="secondary" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          Regenerate
        </button>
      </div>
      {data.stale ? <p className="error">This result is stale. Regenerate it before relying on it.</p> : null}
      {humanDecision ? <p><strong>Your decision:</strong> {humanDecision}</p> : null}
      <p>
        <strong>LLM suggestion:</strong> {data.suggestedDecision ?? 'uncertain'}
        {data.confidence ? ` · ${data.confidence} confidence` : ''}
      </p>
      {disagrees ? <p className="muted">Your decision and the LLM suggestion differ.</p> : null}
      {data.reasoningSummary ? <p>{data.reasoningSummary}</p> : null}
      {(data.criteria ?? []).map((criterion) => (
        <details key={criterion.criterionId ?? criterion.criterionText} open={stage === 'full_text'}>
          <summary>{criterion.criterionText} · {statusText(criterion.assessment)}</summary>
          <p>{criterion.explanation}</p>
          {stage === 'full_text' ? (
            <LlmEvidence
              evidence={criterion.evidence}
              projectId={projectId}
              publicationId={publicationId}
            />
          ) : null}
        </details>
      ))}
    </aside>
  )
}
