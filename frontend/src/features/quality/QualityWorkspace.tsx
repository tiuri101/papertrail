import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { DoiPill } from '../../components/DoiPill'
import { IconArrowRight, IconCheckCircle } from '../../components/icons'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { isAnswered } from '../forms/answers'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { DynamicForm, type DynamicFormField } from '../forms/DynamicForm'
import { fullTextDocumentEndpoint, useFullTextDocument } from '../fulltext/useFullTextDocument'

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
  currentResponse: QualityResponse | null
}

interface QualityResponse {
  id: string
  answers: Record<string, unknown>
  totalScore: number | null
  version: number
}

export interface QualityWorkspaceProps {
  projectId: string
  itemId?: string
  /** 'page' renders its own card chrome (title, links); 'inline' is embedded in a caller-provided card. */
  variant?: 'page' | 'inline'
  onSubmitted?: (info: { id: string; publicationTitle: string; totalScore: number | null }) => void
  onCancel?: () => void
}

export function QualityWorkspace({
  projectId,
  itemId,
  variant = 'page',
  onSubmitted,
  onCancel,
}: QualityWorkspaceProps) {
  const navigate = useNavigate()
  const [item, setItem] = useState<WorkItem | null>(null)
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [queueEmpty, setQueueEmpty] = useState(false)
  const [loadingNext, setLoadingNext] = useState(true)
  const [nextError, setNextError] = useState<string | null>(null)
  const [completedResponse, setCompletedResponse] = useState<QualityResponse | null>(null)
  const skippedItemIds = useRef<Set<string>>(new Set())
  const fullTextDocument = useFullTextDocument(projectId, item?.publicationId ?? '')

  const next = useMutation({
    mutationFn: () => {
      if (itemId) return apiRequest<WorkItem>(`/api/v1/projects/${projectId}/quality/${itemId}`)
      const params = new URLSearchParams()
      skippedItemIds.current.forEach((id) => params.append('excludedItemId', id))
      const query = params.toString()
      return apiRequest<WorkItem | null>(
        `/api/v1/projects/${projectId}/quality/next${query ? `?${query}` : ''}`,
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
      setCompletedResponse(result?.currentResponse ?? null)
      setQueueEmpty(!itemId && result === null)
      setLoadingNext(false)
    },
    onError: (error) => {
      setNextError(error instanceof Error ? error.message : 'Failed to load the next assessment')
      setLoadingNext(false)
    },
  })
  // See TitleAbstractScreeningPage.tsx for why loading/error state is tracked locally
  // instead of read off next.isPending/next.error.
  const fetchNext = () => {
    setLoadingNext(true)
    setNextError(null)
    next.mutate()
  }

  const skip = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('No assessment is open')
      await apiRequest(
        `/api/v1/projects/${projectId}/quality/${item.id}/release`,
        { method: 'POST' },
      )
      return item.id
    },
    onSuccess: (skippedId) => {
      skippedItemIds.current.add(skippedId)
      setItem(null)
      setAnswers({})
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

  const submit = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No assessment is open')
      return apiRequest<QualityResponse>(
        `/api/v1/projects/${projectId}/quality/${item.id}`,
        {
          method: 'POST',
          body: JSON.stringify({ answers }),
        },
      )
    },
    onSuccess: (response) => {
      if (item) {
        onSubmitted?.({
          id: item.id,
          publicationTitle: item.publication.title,
          totalScore: response.totalScore,
        })
      }
      if (itemId) {
        setCompletedResponse(response)
        return
      }
      setItem(null)
      setAnswers({})
      fetchNext()
    },
  })

  useEffect(() => {
    if (!item || completedResponse) return
    const timer = setTimeout(() => {
      apiRequest(
        `/api/v1/projects/${projectId}/quality/${item.id}/draft`,
        { method: 'PUT', body: JSON.stringify({ draft: answers }) },
      ).catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [item, projectId, answers, completedResponse])

  const missingRequired = item?.fields.some(
    (field) => field.required && !isAnswered(answers[field.stableKey]),
  ) ?? false

  const titleRef = useRef<HTMLHeadingElement>(null)
  const visibleItemId = item?.id
  useEffect(() => {
    if (variant !== 'inline' && visibleItemId) titleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [variant, visibleItemId])

  if (!item) {
    return (
      <>
        {loadingNext ? <p>Loading the next assessment…</p> : null}
        {!loadingNext && queueEmpty ? (
          <>
            <p>You have completed all of your assigned assessment work.</p>
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
          <h2 ref={titleRef} className="publication-title">{item.publication.title}</h2>
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
          {fullTextDocument.data?.available ? (
            <a
              className="button-secondary button-sm"
              href={`${fullTextDocumentEndpoint(projectId, item.publicationId)}/content`}
              target="_blank"
              rel="noreferrer"
            >
              Open PDF
            </a>
          ) : null}
        </>
      ) : null}
      <form onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
        <DynamicForm
          fields={item.fields}
          value={answers}
          onChange={(key, value) => setAnswers((current) => ({ ...current, [key]: value }))}
        />
        {missingRequired ? (
          <p className="muted">Answer every required field before submitting.</p>
        ) : null}
        {submit.error ? <p className="error" role="alert">{submit.error.message}</p> : null}
        {skip.error ? <p className="error" role="alert">{skip.error.message}</p> : null}
        <div className="toolbar">
          <button type="submit" disabled={submit.isPending || skip.isPending || missingRequired}>
            <IconCheckCircle />
            {completedResponse ? 'Save corrected assessment' : 'Submit Assessment'}
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
      </form>
    </>
  )

  return variant === 'inline' ? body : <article className="card">{body}</article>
}
