import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { DoiPill } from '../../components/DoiPill'
import { IconArrowRight, IconCheckCircle, IconRestart } from '../../components/icons'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { isAnswered, normalizeForSuggestionMatch } from '../forms/answers'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { DynamicForm, type DynamicFormField } from '../forms/DynamicForm'
import { fullTextDocumentEndpoint, useFullTextDocument } from '../fulltext/useFullTextDocument'
import { LlmAssistanceHeading, LlmEvidence, type LlmEvidenceItem } from '../llm/LlmTaskComponents'

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
  status: string
  draft: Record<string, unknown>
  publication: PublicationSummary
  fields: DynamicFormField[]
  currentResponse: ExtractionResponse | null
}

interface LlmSuggestion {
  id: string
  mappedExtractionFieldKey: string | null
  label: string
  value: unknown
  status: 'explicit' | 'inferred' | 'ambiguous' | 'not_found' | 'not_applicable'
  evidence: LlmEvidenceItem[]
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

interface ExtractionResponse {
  id: string
  answers: Record<string, unknown>
  version: number
  formVersionId: string
}

interface ValidationResult {
  fieldKey: string
  fieldLabel: string
  value: unknown
  assessment: 'supported' | 'contradicted' | 'uncertain' | 'not_verifiable'
  explanation: string
  evidence: LlmEvidenceItem[]
  evidenceValidationStatus: string
}

interface ValidationAssistance {
  state: string
  runId: string | null
  responseId: string | null
  model: string | null
  promptVersion: string | null
  stale: boolean
  error: string | null
  results: ValidationResult[]
}

export interface ExtractionWorkspaceProps {
  projectId: string
  itemId?: string
  /** 'page' renders its own card chrome (title, links); 'inline' is embedded in a caller-provided card. */
  variant?: 'page' | 'inline'
  onSubmitted?: (info: { id: string; publicationTitle: string }) => void
  onCancel?: () => void
}

export function ExtractionWorkspace({
  projectId,
  itemId,
  variant = 'page',
  onSubmitted,
  onCancel,
}: ExtractionWorkspaceProps) {
  const navigate = useNavigate()
  const [item, setItem] = useState<WorkItem | null>(null)
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [queueEmpty, setQueueEmpty] = useState(false)
  const [loadingNext, setLoadingNext] = useState(true)
  const [nextError, setNextError] = useState<string | null>(null)
  const [suggestionActions, setSuggestionActions] = useState<Record<string, 'accepted' | 'modified' | 'ignored' | 'manual'>>({})
  const [completedResponse, setCompletedResponse] = useState<ExtractionResponse | null>(null)
  const skippedItemIds = useRef<Set<string>>(new Set())
  const fullTextDocument = useFullTextDocument(projectId, item?.publicationId ?? '')
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
    mutationFn: () => {
      if (itemId) return apiRequest<WorkItem>(`/api/v1/projects/${projectId}/extraction/${itemId}`)
      const params = new URLSearchParams()
      skippedItemIds.current.forEach((id) => params.append('excludedItemId', id))
      const query = params.toString()
      return apiRequest<WorkItem | null>(
        `/api/v1/projects/${projectId}/extraction/next${query ? `?${query}` : ''}`,
        { method: 'POST' },
      )
    },
    onSuccess: (result) => {
      if (!itemId && result === null && skippedItemIds.current.size > 0) {
        skippedItemIds.current.clear()
        next.mutate()
        return
      }
      setItem(result)
      setAnswers(result?.draft ?? {})
      setSuggestionActions({})
      setCompletedResponse(result?.currentResponse ?? null)
      setQueueEmpty(!itemId && result === null)
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

  const skip = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('No extraction is open')
      await apiRequest(
        `/api/v1/projects/${projectId}/extraction/${item.id}/release`,
        { method: 'POST' },
      )
      return item.id
    },
    onSuccess: (skippedId) => {
      skippedItemIds.current.add(skippedId)
      setItem(null)
      setAnswers({})
      setSuggestionActions({})
      fetchNext()
    },
  })

  const autoFetchKey = useRef<string | null>(null)
  useEffect(() => {
    const key = `${projectId}:${itemId ?? 'next'}`
    if (autoFetchKey.current !== key) {
      autoFetchKey.current = key
      fetchNext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, itemId])

  const visibleItemId = item?.id
  useEffect(() => {
    if (variant !== 'inline' && visibleItemId) window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [variant, visibleItemId])

  const submit = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No extraction is open')
      return apiRequest<ExtractionResponse>(
        `/api/v1/projects/${projectId}/extraction/${item.id}`,
        {
          method: 'POST',
          body: JSON.stringify({
            answers,
            ...(Object.keys(suggestionActions).length ? { suggestionActions } : {}),
          }),
        },
      )
    },
    onSuccess: (response) => {
      if (item) onSubmitted?.({ id: item.id, publicationTitle: item.publication.title })
      if (itemId) {
        setCompletedResponse(response)
        return
      }
      setItem(null)
      setAnswers({})
      setSuggestionActions({})
      setCompletedResponse(null)
      fetchNext()
    },
  })

  const validation = useQuery({
    queryKey: ['extraction-validation', projectId, item?.id, completedResponse?.id],
    queryFn: () => apiRequest<ValidationAssistance>(
      `/api/v1/projects/${projectId}/extraction/${item?.id}/llm-validation`,
    ),
    enabled: Boolean(item?.id && completedResponse && itemId),
    refetchInterval: (query) => (
      ['pending', 'queued', 'processing'].includes(query.state.data?.state ?? '') ? 5000 : false
    ),
  })
  useEffect(() => {
    if (!item || completedResponse) return
    const timer = setTimeout(() => {
      apiRequest(
        `/api/v1/projects/${projectId}/extraction/${item.id}/draft`,
        { method: 'PUT', body: JSON.stringify({ draft: answers }) },
      ).catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [item, projectId, answers, completedResponse])

  const missingRequired = item?.fields.some(
    (field) => field.required && !isAnswered(answers[field.stableKey]),
  ) ?? false

  const suggestionByField = new Map(
    (assistance.data?.suggestions ?? [])
      .filter((suggestion) => suggestion.mappedExtractionFieldKey)
      .map((suggestion) => [suggestion.mappedExtractionFieldKey, suggestion]),
  )
  const helpers = (assistance.data?.suggestions ?? []).filter((suggestion) => suggestion.helper)
  const validationByField = new Map(
    (validation.data?.results ?? []).map((result) => [result.fieldKey, result]),
  )
  const validationCounts = (validation.data?.results ?? []).reduce<Record<string, number>>(
    (counts, result) => ({
      ...counts,
      [result.assessment]: (counts[result.assessment] ?? 0) + 1,
    }),
    {},
  )

  const suggestionCard = (field: DynamicFormField) => {
    const suggestion = suggestionByField.get(field.stableKey)
    const validationResult = validationByField.get(field.stableKey)
    if (!suggestion && !validationResult) return null
    const current = answers[field.stableKey]
    const applied = suggestion
      ? JSON.stringify(normalizeForSuggestionMatch(field.fieldType, current))
        === JSON.stringify(normalizeForSuggestionMatch(field.fieldType, suggestion.value))
      : false
    const status = suggestion?.status.replace('_', ' ')
    return (
      <>
      {suggestion ? (
        <aside
          className={`llm-task-panel${applied ? ' llm-task-panel--match' : ''}`}
          aria-label={applied ? `LLM suggestion for ${field.label} — matches your value` : `LLM suggestion for ${field.label}`}
        >
          <div className="llm-task-panel__heading">
            <strong>
              <span className="llm-task-panel__icon" aria-hidden="true">✦</span>
              {' '}LLM suggestion · {status}
            </strong>
            {applied ? <span className="muted">Reviewer value matches suggestion</span> : null}
          </div>
          {suggestion.status === 'inferred' ? (
            <p>⚠ This value is inferred; the paper does not state it directly.</p>
          ) : null}
          {['not_found', 'not_applicable'].includes(suggestion.status) ? (
            <p>{suggestion.status === 'not_found' ? 'Not found in the paper.' : 'Not applicable.'}</p>
          ) : (
            <>
              <p><code>{JSON.stringify(suggestion.value)}</code></p>
              <div className="toolbar">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    setAnswers((values) => ({
                      ...values, [field.stableKey]: suggestion.value,
                    }))
                    setSuggestionActions((actions) => ({
                      ...actions, [field.stableKey]: 'accepted',
                    }))
                  }}
                >
                  {isAnswered(current) || applied ? 'Reset to LLM suggestion' : 'Apply suggestion'}
                </button>
              </div>
            </>
          )}
          {suggestion.evidence.length ? (
            <details>
              <summary>Evidence ({suggestion.evidence.length})</summary>
              <LlmEvidence
                evidence={suggestion.evidence}
                projectId={projectId}
                publicationId={item?.publicationId ?? ''}
              />
            </details>
          ) : suggestion.evidenceRequired && suggestion.value != null ? (
            <p className="error">No verified supporting evidence was returned.</p>
          ) : null}
        </aside>
      ) : null}
      {validationResult ? (
        <aside className={`llm-validation llm-validation--${validationResult.assessment}`}>
          <strong>Validation: {validationResult.assessment.replace('_', ' ')}</strong>
          <p>{validationResult.explanation}</p>
          {validationResult.evidence.length ? (
            <details>
              <summary>Validation evidence ({validationResult.evidence.length})</summary>
              <LlmEvidence
                evidence={validationResult.evidence}
                projectId={projectId}
                publicationId={item?.publicationId ?? ''}
              />
            </details>
          ) : null}
        </aside>
      ) : null}
      </>
    )
  }

  if (!item) {
    return (
      <>
        {loadingNext ? <p>Loading the next extraction…</p> : null}
        {!loadingNext && queueEmpty ? (
          <>
            <p>You have completed all of your assigned extraction work.</p>
            <button type="button" className="button-secondary" onClick={() => navigate(`/projects/${projectId}`)}>
              Back to project
            </button>
          </>
        ) : null}
        {!loadingNext && nextError ? (
          <p className="error" role="alert">{nextError}</p>
        ) : null}
      </>
    )
  }

  const body = (
    <>
      {variant !== 'inline' ? (
        <>
          <h2>{item.publication.title}</h2>
          <p className="muted">
            {item.publication.authors ?? 'Unknown authors'}
            {item.publication.publicationYear ? ` (${item.publication.publicationYear})` : ''}
          </p>
          <div className="toolbar">
            {fullTextDocument.data ? (
              <PdfAvailabilityPill
                available={fullTextDocument.data.available}
                href={`${fullTextDocumentEndpoint(projectId, item.publicationId)}/content`}
                pageCount={fullTextDocument.data.document?.pageCount}
              />
            ) : null}
            <DoiPill doi={item.publication.doi} />
            {isSafeHttpUrl(item.publication.publisherUrl) ? (
              <PublisherLinkPill url={item.publication.publisherUrl} />
            ) : null}
          </div>
        </>
      ) : null}
      {assistance.isLoading ? (
        <aside className="llm-task-panel" aria-label="LLM assistance">
          <div className="llm-task-panel__heading">
            <LlmAssistanceHeading />
          </div>
          <p className="muted">Checking for LLM suggestions…</p>
        </aside>
      ) : null}
      {assistance.data?.state && assistance.data.state !== 'ready' && assistance.data.state !== 'disabled' ? (
        <aside className="llm-task-panel" aria-label="LLM assistance">
          <div className="llm-task-panel__heading">
            <LlmAssistanceHeading qualifier={assistance.data.state === 'failed' ? 'failed' : undefined} />
            {['unavailable', 'failed', 'cancelled'].includes(assistance.data.state) ? (
              <button
                type="button"
                className="button-secondary"
                onClick={() => runLlm.mutate(assistance.data?.state === 'failed')}
                disabled={runLlm.isPending}
              >
                {runLlm.isPending ? 'Queueing…' : assistance.data.state === 'failed' ? 'Re-run LLM extraction' : 'Run LLM extraction'}
              </button>
            ) : null}
          </div>
          <p className={assistance.data.state === 'failed' ? 'error' : 'muted'}>
            LLM assistance: {assistance.data.state.replaceAll('_', ' ')}
            {assistance.data.error ? ` — ${assistance.data.error}` : ''}. Manual extraction remains available.
          </p>
        </aside>
      ) : null}
      {assistance.data?.outdated ? (
        <aside className="llm-task-panel" aria-label="LLM assistance is stale">
          <div className="llm-task-panel__heading">
            <LlmAssistanceHeading qualifier="is stale" />
            <button type="button" className="button-secondary" onClick={() => runLlm.mutate(true)} disabled={runLlm.isPending}>
              <IconRestart />
              Re-run with current schema
            </button>
          </div>
          <p className="muted">LLM result uses an older schema version.</p>
        </aside>
      ) : null}
      {runLlm.error ? <p className="error" role="alert">{runLlm.error.message}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
        <DynamicForm
          fields={item.fields}
          value={answers}
          onChange={(key, value) => {
            setAnswers((current) => ({ ...current, [key]: value }))
            setSuggestionActions((actions) => ({
              ...actions,
              [key]: actions[key] === 'accepted' ? 'modified' : 'manual',
            }))
          }}
          renderAssistance={suggestionCard}
        />
        {helpers.length ? (
          <aside className="llm-task-panel" aria-label="Additional LLM assistance">
            <div className="llm-task-panel__heading">
              <h3>
                <span className="llm-task-panel__icon" aria-hidden="true">✦</span>
                {' '}Additional LLM assistance
              </h3>
            </div>
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
        {skip.error ? <p className="error" role="alert">{skip.error.message}</p> : null}
        <div className="toolbar">
          <button type="submit" disabled={submit.isPending || skip.isPending || missingRequired}>
            <IconCheckCircle />
            {completedResponse ? 'Save corrected extraction' : 'Submit Extraction'}
          </button>
          {!itemId ? (
            <button
              type="button"
              className="button-secondary"
              onClick={() => skip.mutate()}
              disabled={submit.isPending || skip.isPending}
            >
              <IconArrowRight />
              Skip for now
            </button>
          ) : null}
          {variant === 'inline' && onCancel ? (
            <button
              type="button"
              className="button-secondary"
              onClick={onCancel}
              disabled={submit.isPending}
            >
              Cancel
            </button>
          ) : null}
        </div>
        {completedResponse && itemId && validation.data?.state !== 'disabled' ? (
          <section className="llm-task-panel" aria-label="Extraction validation">
            <h3>
              <span className="llm-task-panel__icon" aria-hidden="true">✦</span>
              {' '}LLM extraction validation
            </h3>
            {validation.isLoading ? <p>Checking validation status…</p> : null}
            {validation.data?.stale ? (
              <p className="error">Validation is stale because the extraction or source changed.</p>
            ) : null}
            {['queued', 'pending', 'processing'].includes(validation.data?.state ?? '') ? (
              <p>Validation {validation.data?.state}… Manual work remains available.</p>
            ) : null}
            {validation.data?.state === 'ready' ? (
              <p>
                {validationCounts.supported ?? 0} supported · {' '}
                {validationCounts.uncertain ?? 0} uncertain · {' '}
                {validationCounts.contradicted ?? 0} contradicted · {' '}
                {validationCounts.not_verifiable ?? 0} not verifiable
              </p>
            ) : null}
            {validation.data?.state === 'failed' ? (
              <p className="error">{validation.data.error ?? 'Validation failed.'}</p>
            ) : null}
            <Link to={`/projects/${projectId}/extraction/validation`}>
              Back to validation review
            </Link>
          </section>
        ) : null}
      </form>
    </>
  )

  return variant === 'inline' ? body : <article className="card">{body}</article>
}
