import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { DynamicForm, type DynamicFormField } from '../forms/DynamicForm'

interface PublicationSummary {
  title: string
  authors: string | null
  publicationYear: number | null
  doi: string | null
  publisherUrl: string | null
}

interface WorkItem {
  id: string
  publicationId: string
  fullTextAvailable: boolean
  status: string
  draft: Record<string, unknown>
  publication: PublicationSummary
  fields: DynamicFormField[]
}

interface Evidence {
  page: number
  quote: string
  verified: boolean
}

interface LlmSuggestion {
  id: string
  mappedExtractionFieldKey: string | null
  label: string
  value: unknown
  status: 'explicit' | 'inferred' | 'ambiguous' | 'not_found' | 'not_applicable'
  evidence: Evidence[]
  evidenceValidationStatus: string
  evidenceRequired: boolean
  helper: boolean
}

interface LlmAssistance {
  state: string
  runId: string | null
  documentId: string | null
  schemaVersion: number | null
  model: string | null
  outdated: boolean
  error: string | null
  suggestions: LlmSuggestion[]
}

function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function ExtractionPage() {
  const { projectId = '' } = useParams()
  const [item, setItem] = useState<WorkItem | null>(null)
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [queueEmpty, setQueueEmpty] = useState(false)
  const [loadingNext, setLoadingNext] = useState(true)
  const [nextError, setNextError] = useState<string | null>(null)
  const assistance = useQuery({
    queryKey: ['extraction-llm', projectId, item?.id],
    queryFn: () => apiRequest<LlmAssistance>(
      `/api/v1/projects/${projectId}/extraction/${item?.id}/llm-suggestions`,
    ),
    enabled: Boolean(item?.id),
    refetchInterval: (query) => (
      ['pending', 'processing', 'queued'].includes(query.state.data?.state ?? '') ? 5000 : false
    ),
  })
  const runLlm = useMutation({
    mutationFn: (force: boolean) => apiRequest(
      `/api/v1/projects/${projectId}/publications/${item?.publicationId}/llm/run`,
      { method: 'POST', body: JSON.stringify({ force }) },
    ),
    onSuccess: () => assistance.refetch(),
  })

  const next = useMutation({
    mutationFn: () => apiRequest<WorkItem | null>(
      `/api/v1/projects/${projectId}/extraction/next`,
      { method: 'POST' },
    ),
    onSuccess: (result) => {
      setItem(result)
      setAnswers(result?.draft ?? {})
      setQueueEmpty(result === null)
      setLoadingNext(false)
    },
    onError: (error) => {
      setNextError(error instanceof Error ? error.message : 'Failed to load the next extraction')
      setLoadingNext(false)
    },
  })
  // See ScreeningPage.tsx for why loading/error state is tracked locally
  // instead of read off next.isPending/next.error.
  const fetchNext = () => {
    setLoadingNext(true)
    setNextError(null)
    next.mutate()
  }

  const autoFetchKey = useRef<string | null>(null)
  useEffect(() => {
    if (autoFetchKey.current !== projectId) {
      autoFetchKey.current = projectId
      fetchNext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const submit = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No extraction is open')
      return apiRequest(
        `/api/v1/projects/${projectId}/extraction/${item.id}`,
        {
          method: 'POST',
          body: JSON.stringify({ answers }),
        },
      )
    },
    onSuccess: () => {
      setItem(null)
      setAnswers({})
      fetchNext()
    },
  })

  useEffect(() => {
    if (!item) return
    const timer = setTimeout(() => {
      apiRequest(
        `/api/v1/projects/${projectId}/extraction/${item.id}/draft`,
        { method: 'PUT', body: JSON.stringify({ draft: answers }) },
      ).catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [item, projectId, answers])

  const missingRequired = item?.fields.some(
    (field) => field.required && !isAnswered(answers[field.stableKey]),
  ) ?? false

  const suggestionByField = new Map(
    (assistance.data?.suggestions ?? [])
      .filter((suggestion) => suggestion.mappedExtractionFieldKey)
      .map((suggestion) => [suggestion.mappedExtractionFieldKey, suggestion]),
  )
  const helpers = (assistance.data?.suggestions ?? []).filter((suggestion) => suggestion.helper)

  const suggestionCard = (field: DynamicFormField) => {
    const suggestion = suggestionByField.get(field.stableKey)
    if (!suggestion) return null
    const current = answers[field.stableKey]
    const applied = JSON.stringify(current) === JSON.stringify(suggestion.value)
    const status = suggestion.status.replace('_', ' ')
    return (
      <aside className={`llm-suggestion llm-suggestion--${suggestion.status}`}>
        <div className="llm-suggestion__heading">
          <strong>✦ LLM suggestion · {status}</strong>
          {applied ? <span>Reviewer value matches suggestion</span> : null}
        </div>
        {suggestion.status === 'inferred' ? (
          <p>⚠ This value is inferred; the paper does not state it directly.</p>
        ) : null}
        {['not_found', 'not_applicable'].includes(suggestion.status) ? (
          <p>{suggestion.status === 'not_found' ? 'Not found in the paper.' : 'Not applicable.'}</p>
        ) : (
          <>
            <p><code>{JSON.stringify(suggestion.value)}</code></p>
            <button
              type="button"
              className="secondary"
              onClick={() => setAnswers((values) => ({
                ...values, [field.stableKey]: suggestion.value,
              }))}
            >
              {isAnswered(current) ? 'Reset to LLM suggestion' : 'Apply suggestion'}
            </button>
          </>
        )}
        {suggestion.evidence.length ? (
          <details>
            <summary>Evidence ({suggestion.evidence.length})</summary>
            {suggestion.evidence.map((evidence, index) => (
              <blockquote key={`${evidence.page}-${index}`}>
                <p>
                  p. {evidence.page} · {evidence.verified ? 'Verified evidence' : 'Unverified evidence'}
                </p>
                <q>{evidence.quote}</q>
                <p>
                  <a
                    href={`/api/v1/projects/${projectId}/publications/${item?.publicationId}/full-text/content#page=${evidence.page}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open PDF at page {evidence.page}
                  </a>
                </p>
              </blockquote>
            ))}
          </details>
        ) : suggestion.evidenceRequired && suggestion.value != null ? (
          <p className="error">No verified supporting evidence was returned.</p>
        ) : null}
      </aside>
    )
  }

  return (
    <main className="page">
      <h1>Data Extraction</h1>
      {!item ? (
        <>
          {loadingNext ? <p>Loading the next extraction…</p> : null}
          {!loadingNext && queueEmpty ? <p>No extraction work is currently available.</p> : null}
          {!loadingNext && nextError ? (
            <p className="error" role="alert">{nextError}</p>
          ) : null}
        </>
      ) : (
        <article className="card">
          <h2>{item.publication.title}</h2>
          <p className="muted">
            {item.publication.authors ?? 'Unknown authors'}
            {item.publication.publicationYear ? ` (${item.publication.publicationYear})` : ''}
          </p>
          <div className="toolbar">
            {item.fullTextAvailable ? (
              <a
                href={`/api/v1/projects/${projectId}/publications/${item.publicationId}/full-text/content`}
                target="_blank"
                rel="noreferrer"
              >
                View PDF
              </a>
            ) : null}
            {item.publication.doi ? (
              <a href={`https://doi.org/${item.publication.doi}`} target="_blank" rel="noreferrer">
                Open DOI
              </a>
            ) : isSafeHttpUrl(item.publication.publisherUrl) ? (
              <a href={item.publication.publisherUrl} target="_blank" rel="noreferrer">
                Open publisher page
              </a>
            ) : null}
          </div>
          {assistance.isLoading ? <p className="muted">Checking for LLM suggestions…</p> : null}
          {assistance.data?.state && assistance.data.state !== 'ready' ? (
            <p className={assistance.data.state === 'failed' ? 'error' : 'muted'}>
              LLM assistance: {assistance.data.state.replaceAll('_', ' ')}
              {assistance.data.error ? ` — ${assistance.data.error}` : ''}. Manual extraction remains available.
            </p>
          ) : null}
          {assistance.data?.outdated ? <p className="muted">LLM result uses an older schema version.</p> : null}
          {assistance.data && ['unavailable', 'failed', 'cancelled'].includes(assistance.data.state) ? (
            <button type="button" className="secondary" onClick={() => runLlm.mutate(assistance.data?.state === 'failed')} disabled={runLlm.isPending}>
              {runLlm.isPending ? 'Queueing…' : assistance.data.state === 'failed' ? 'Re-run LLM extraction' : 'Run LLM extraction'}
            </button>
          ) : null}
          {assistance.data?.outdated ? (
            <button type="button" className="secondary" onClick={() => runLlm.mutate(true)} disabled={runLlm.isPending}>Re-run with current schema</button>
          ) : null}
          {runLlm.error ? <p className="error" role="alert">{runLlm.error.message}</p> : null}
          <form onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
            <DynamicForm
              fields={item.fields}
              value={answers}
              onChange={(key, value) => setAnswers((current) => ({ ...current, [key]: value }))}
              renderAssistance={suggestionCard}
            />
            {helpers.length ? (
              <aside className="llm-helper-panel">
                <h3>Additional LLM assistance</h3>
                {helpers.map((helper) => (
                  <section key={helper.id}>
                    <h4>{helper.label}</h4>
                    <p>{String(helper.value ?? helper.status.replace('_', ' '))}</p>
                  </section>
                ))}
              </aside>
            ) : null}
            {missingRequired ? (
              <p className="muted">Answer every required field before submitting.</p>
            ) : null}
            {submit.error ? <p className="error" role="alert">{submit.error.message}</p> : null}
            <button type="submit" disabled={submit.isPending || missingRequired}>
              Submit Extraction
            </button>
          </form>
        </article>
      )}
    </main>
  )
}
