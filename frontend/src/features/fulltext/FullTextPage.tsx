import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { CriteriaAnswerFields } from '../screening/CriteriaAnswerFields'
import { ScreeningItemCard } from '../screening/ScreeningItemCard'
import type { CriterionAnswer, ScreeningCriterion } from '../screening/useScreeningQueue'
import { useScreeningQueue } from '../screening/useScreeningQueue'
import type { Retrieval } from './useRetrievalQueue'
import { useRetrievalQueue } from './useRetrievalQueue'
import { FullTextDocumentPanel } from './FullTextDocumentPanel'

interface ProjectCriteria {
  criteria: ScreeningCriterion[]
}

const statusLabels: Record<string, string> = {
  not_yet_sought: 'Not yet sought',
  requested: 'Requested',
  not_found: 'Not found',
  inaccessible: 'Inaccessible',
  available: 'Available',
}

function formatStatus(status: string) {
  return statusLabels[status] ?? status
}

const retrievalStatusOptions = Object.keys(statusLabels)

function defaultAnswerForKind(kind: string): boolean {
  return kind === 'inclusion'
}

interface RetrievalDecision {
  outcome: string
  criteriaAnswers: Record<string, boolean>
  notes: string | null
}

export function FullTextPage() {
  const { projectId = '' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const queue = useScreeningQueue(projectId, 'full_text')
  const retrievalQueue = useRetrievalQueue(projectId)

  const criteria = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectCriteria>(`/api/v1/projects/${projectId}`),
  })

  const updateRetrieval = useMutation({
    mutationFn: ({ id, status, note, decision }: {
      id: string
      status: string
      note: string | null
      decision: RetrievalDecision | null
    }) =>
      apiRequest<{ decisionSubmitted: boolean }>(`/api/v1/projects/${projectId}/full-text/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status, note, decision }),
      }),
  })

  const handleSubmit = async (
    retrieval: Retrieval,
    status: string,
    note: string | null,
    decision: RetrievalDecision | null,
  ) => {
    const result = await updateRetrieval.mutateAsync({ id: retrieval.id, status, note, decision })
    if (status === 'available' && !result.decisionSubmitted) queue.fetchNext()
    retrievalQueue.advance()
  }

  const progress = retrievalQueue.progress
  const isLoading = retrievalQueue.loadingNext || queue.loadingNext || progress === undefined

  return (
    <main className="page">
      <h1>Full-Text</h1>
      {retrievalQueue.nextError ? <p className="error" role="alert">{retrievalQueue.nextError}</p> : null}
      {updateRetrieval.error ? <p className="error" role="alert">{updateRetrieval.error.message}</p> : null}
      {queue.nextError ? <p className="error" role="alert">{queue.nextError}</p> : null}
      {progress ? (
        <p className="muted">{progress.addressed} of {progress.total} retrieval decisions made</p>
      ) : null}
      {queue.item ? (
        <>
          <FullTextDocumentPanel
            projectId={projectId}
            publicationId={queue.item.publication.id}
          />
          <ScreeningItemCard {...queue} highlightKeywords={highlightKeywords} />
        </>
      ) : isLoading ? (
        <p>Loading…</p>
      ) : progress?.total === 0 ? (
        <p className="muted">No publications require full-text retrieval.</p>
      ) : retrievalQueue.item ? (
        <RetrievalCard
          projectId={projectId}
          retrieval={retrievalQueue.item}
          criteria={criteria.data?.criteria ?? []}
          saving={updateRetrieval.isPending}
          onSubmit={(status, note, decision) => handleSubmit(retrievalQueue.item!, status, note, decision)}
        />
      ) : (
        <p className="muted">No full-text work is currently available for you.</p>
      )}
    </main>
  )
}

function RetrievalCard({ projectId, retrieval, criteria, saving, onSubmit }: {
  projectId: string
  retrieval: Retrieval
  criteria: ScreeningCriterion[]
  saving: boolean
  onSubmit: (status: string, note: string | null, decision: RetrievalDecision | null) => void
}) {
  const [status, setStatus] = useState(retrieval.status)
  const [note, setNote] = useState(retrieval.note ?? '')
  const [answers, setAnswers] = useState<Record<string, CriterionAnswer>>({})
  const [outcome, setOutcome] = useState('include')
  const [notes, setNotes] = useState('')
  const publication = retrieval.publication
  const isAvailable = status === 'available'

  useEffect(() => {
    if (!isAvailable) return
    setAnswers((current) => {
      const next = { ...current }
      let changed = false
      criteria.forEach((criterion) => {
        if (!(criterion.id in next)) {
          next[criterion.id] = defaultAnswerForKind(criterion.kind)
          changed = true
        }
      })
      return changed ? next : current
    })
  }, [isAvailable, criteria])

  useEffect(() => {
    const shouldExclude = criteria.some((criterion) => (
      (criterion.kind === 'inclusion' && answers[criterion.id] === false)
      || (criterion.kind === 'exclusion' && answers[criterion.id] === true)
    ))
    if (shouldExclude) setOutcome('exclude')
  }, [answers, criteria])

  const criteriaComplete = criteria.every(
    (criterion) => answers[criterion.id] !== null && answers[criterion.id] !== undefined,
  )

  const handleSubmit = () => {
    if (isAvailable) {
      onSubmit(status, note || null, {
        outcome,
        criteriaAnswers: Object.fromEntries(
          criteria.map((criterion) => [criterion.id, answers[criterion.id] === true]),
        ),
        notes: notes || null,
      })
    } else {
      onSubmit(status, note || null, null)
    }
  }

  return (
    <article className="card">
      <h2>{publication.title}</h2>
      <p className="muted">
        {publication.authors ?? 'Unknown authors'}
        {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
      </p>
      <div className="toolbar">
        {publication.doi ? (
          <a href={`https://doi.org/${publication.doi}`} target="_blank" rel="noreferrer">
            Open DOI
          </a>
        ) : null}
        {isSafeHttpUrl(publication.publisherUrl) ? (
          <a href={publication.publisherUrl!} target="_blank" rel="noreferrer">
            Open publisher page
          </a>
        ) : null}
      </div>
      <FullTextDocumentPanel
        projectId={projectId}
        publicationId={publication.id}
        onAvailable={() => setStatus('available')}
      />
      <label>
        Retrieval status for {publication.title}
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {retrievalStatusOptions.map((statusOption) => (
            <option value={statusOption} key={statusOption}>{formatStatus(statusOption)}</option>
          ))}
        </select>
      </label>
      <label>
        Note for {publication.title}
        <textarea value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {isAvailable ? (
        <>
          <CriteriaAnswerFields
            criteria={criteria}
            answers={answers}
            setAnswers={setAnswers}
            outcome={outcome}
            setOutcome={setOutcome}
            notes={notes}
            setNotes={setNotes}
          />
          {!criteriaComplete ? (
            <p className="muted">Answer every criterion before submitting.</p>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        onClick={handleSubmit}
        disabled={saving || (isAvailable && !criteriaComplete)}
      >
        Submit
      </button>
    </article>
  )
}
