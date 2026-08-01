import { useMutation } from '@tanstack/react-query'
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
  status: string
  draft: Record<string, unknown>
  publication: PublicationSummary
  fields: DynamicFormField[]
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
              Submit Extraction
            </button>
          </form>
        </article>
      )}
    </main>
  )
}
