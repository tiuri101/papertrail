import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Tooltip } from '../../components/Tooltip'
import { LlmEvidence, type LlmEvidenceItem } from '../llm/LlmTaskComponents'

interface ValidationResult {
  fieldKey: string
  fieldLabel: string
  value: unknown
  assessment: 'supported' | 'contradicted' | 'uncertain' | 'not_verifiable'
  explanation: string
  evidence: LlmEvidenceItem[]
  evidenceValidationStatus: string
}

interface ValidationReviewItem {
  workItemId: string
  publicationId: string
  responseId: string | null
  fullTextAvailable: boolean
  state: string
  error: string | null
  publication: {
    id: string
    title: string
    authors: string | null
    publicationYear: number | null
  }
  results: ValidationResult[]
}

interface ValidationReview {
  enabled: boolean
  progress: {
    total: number
    completed: number
    pending: number
    failed: number
    unavailable: number
    outstanding: number
    settled: boolean
  }
  items: ValidationReviewItem[]
}

const NEEDS_REVIEW = new Set(['contradicted', 'uncertain', 'not_verifiable'])

const ASSESSMENT_HELP: Record<ValidationResult['assessment'], string> = {
  supported: 'The AI found evidence in the full text that agrees with the value a human entered for this field.',
  contradicted: 'The AI found evidence in the full text that conflicts with the human-entered value — check the evidence below and correct the extraction if the AI is right.',
  uncertain: 'The AI could not confidently confirm or refute the human-entered value from the text it had access to.',
  not_verifiable: "The AI couldn't find any relevant evidence in the full text to check this value against.",
}

export function ValidationReviewPage() {
  const { projectId = '' } = useParams()
  const review = useQuery({
    queryKey: ['extraction-validation-review', projectId],
    queryFn: () => apiRequest<ValidationReview>(
      `/api/v1/projects/${projectId}/llm/extraction-validation-review`,
    ),
    enabled: Boolean(projectId),
    refetchInterval: (query) => (query.state.data?.progress.settled ? false : 5000),
  })
  const retry = useMutation({
    mutationFn: (item: ValidationReviewItem) => apiRequest(
      `/api/v1/projects/${projectId}/extraction/${item.workItemId}/llm-validation`,
      { method: 'POST', body: JSON.stringify({ force: Boolean(item.responseId) }) },
    ),
    onSuccess: () => review.refetch(),
  })

  if (review.isLoading) return <main className="page"><p>Loading validation review…</p></main>
  if (review.isError || !review.data) {
    return <main className="page"><p className="error" role="alert">Validation review could not be loaded.</p></main>
  }
  if (!review.data.enabled) {
    return (
      <main className="page">
        <h1>LLM Extraction Validation</h1>
        <p>LLM extraction validation is not enabled for this project.</p>
      </main>
    )
  }

  const items = review.data.items
    .map((item) => ({
      ...item,
      issues: item.results.filter((result) => NEEDS_REVIEW.has(result.assessment)),
    }))
    .filter((item) => item.state !== 'ready' || item.issues.length > 0)

  return (
    <main className="page">
      <h1>Review LLM Extraction Validation</h1>
      <section className="card">
        <h2>Validation progress</h2>
        <p>
          {review.data.progress.completed} of {review.data.progress.total} validated
          {review.data.progress.pending ? ` · ${review.data.progress.pending} processing` : ''}
          {review.data.progress.failed ? ` · ${review.data.progress.failed} failed` : ''}
          {review.data.progress.unavailable ? ` · ${review.data.progress.unavailable} unavailable` : ''}
        </p>
        <p className="muted">
          Human extraction values remain authoritative. Review contradicted, uncertain, and
          unverifiable fields here, then open the extraction to make any correction.
        </p>
      </section>

      {retry.error ? <p className="error" role="alert">{retry.error.message}</p> : null}
      {items.length === 0 ? (
        <section className="card"><p>No validation mismatches require review.</p></section>
      ) : items.map((item) => (
        <article className="card" key={item.workItemId}>
          <h2>{item.publication.title}</h2>
          <p className="muted">
            {item.publication.authors ?? 'Unknown authors'}
            {item.publication.publicationYear ? ` (${item.publication.publicationYear})` : ''}
          </p>
          {item.state !== 'ready' ? (
            <p className={item.state === 'failed' ? 'error' : 'muted'}>
              Validation status: {item.state.replaceAll('_', ' ')}
              {item.error ? ` — ${item.error}` : ''}
            </p>
          ) : null}
          {item.issues.map((result) => (
            <section className={`llm-validation llm-validation--${result.assessment}`} key={result.fieldKey}>
              <h3>{result.fieldLabel}</h3>
              <p>
                <Tooltip text={ASSESSMENT_HELP[result.assessment]}>
                  <strong>{result.assessment.replaceAll('_', ' ')}</strong>
                </Tooltip>
              </p>
              <p>Human value: <code>{JSON.stringify(result.value)}</code></p>
              <p>{result.explanation}</p>
              {result.evidence.length ? (
                <details>
                  <summary>Evidence ({result.evidence.length})</summary>
                  <LlmEvidence
                    evidence={result.evidence}
                    projectId={projectId}
                    publicationId={item.publicationId}
                  />
                </details>
              ) : null}
            </section>
          ))}
          <div className="toolbar">
            <Link to={`/projects/${projectId}/extraction/review/${item.workItemId}`}>
              Review and correct extraction
            </Link>
            {item.fullTextAvailable ? (
              <a
                href={`/api/v1/projects/${projectId}/publications/${item.publicationId}/full-text/content`}
                target="_blank"
                rel="noreferrer"
              >
                View PDF
              </a>
            ) : null}
            {['failed', 'awaiting_validation'].includes(item.state) ? (
              <button
                type="button"
                className="button-secondary"
                disabled={retry.isPending}
                onClick={() => retry.mutate(item)}
              >
                Retry validation
              </button>
            ) : null}
          </div>
        </article>
      ))}
    </main>
  )
}
