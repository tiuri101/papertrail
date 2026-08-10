import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { IconCheckCircle } from '../../components/icons'
import { Tooltip } from '../../components/Tooltip'
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

interface QualityProgress {
  assigned: number
  completed: number
}

function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

export function QualityPage() {
  const { projectId = '', itemId } = useParams()
  const navigate = useNavigate()
  const [item, setItem] = useState<WorkItem | null>(null)
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [queueEmpty, setQueueEmpty] = useState(false)
  const [loadingNext, setLoadingNext] = useState(true)
  const [nextError, setNextError] = useState<string | null>(null)
  const [lastScore, setLastScore] = useState<number | null>(null)
  const [completedResponse, setCompletedResponse] = useState<QualityResponse | null>(null)
  const progress = useQuery({
    queryKey: ['quality-progress', projectId],
    queryFn: () => apiRequest<QualityProgress>(`/api/v1/projects/${projectId}/quality/progress`),
    enabled: Boolean(projectId),
  })

  const next = useMutation({
    mutationFn: () => (
      itemId
        ? apiRequest<WorkItem>(`/api/v1/projects/${projectId}/quality/${itemId}`)
        : apiRequest<WorkItem | null>(
          `/api/v1/projects/${projectId}/quality/next`,
          { method: 'POST' },
        )
    ),
    onSuccess: (result) => {
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
  // See ScreeningPage.tsx for why loading/error state is tracked locally
  // instead of read off next.isPending/next.error.
  const fetchNext = () => {
    setLoadingNext(true)
    setNextError(null)
    next.mutate()
  }

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
      progress.refetch()
      setLastScore(response.totalScore)
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

  return (
    <main className="page">
      <h1>Quality Assessment</h1>
      {progress.data ? (
        <p className="muted">{progress.data.completed} of {progress.data.assigned} assigned papers assessed</p>
      ) : null}
      {lastScore !== null ? (
        <p>
          Submitted —{' '}
          <Tooltip text="The sum of the points assigned to each answer on this quality-assessment checklist, as configured by your project administrator. There's no universal maximum — check the checklist design for how it's scored.">
            <span>total score: {lastScore}</span>
          </Tooltip>
        </p>
      ) : null}
      {!item ? (
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
      ) : (
        <article className="card">
          <h2>{item.publication.title}</h2>
          <p className="muted">
            {item.publication.authors ?? 'Unknown authors'}
            {item.publication.publicationYear ? ` (${item.publication.publicationYear})` : ''}
          </p>
          {item.publication.doi ? (
            <p>
              <a href={`https://doi.org/${item.publication.doi}`} target="_blank" rel="noreferrer">
                Open DOI
              </a>
            </p>
          ) : isSafeHttpUrl(item.publication.publisherUrl) ? (
            <p>
              <a href={item.publication.publisherUrl} target="_blank" rel="noreferrer">
                Open publisher page
              </a>
            </p>
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
            <button type="submit" disabled={submit.isPending || missingRequired}>
              <IconCheckCircle />
              {completedResponse ? 'Save corrected assessment' : 'Submit Assessment'}
            </button>
          </form>
        </article>
      )}
    </main>
  )
}
