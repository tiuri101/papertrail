import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface WorkItem {
  id: string
  publication: {
    title: string
    authors: string | null
    abstract: string | null
    doi: string | null
    publisherUrl: string | null
  }
  criteria: Array<{ id: string; kind: string; text: string }>
  draft: Record<string, unknown>
}
interface ProjectDetail {
  exclusionReasons: Array<{ id: string; stage: string; label: string }>
}

type CriterionAnswer = boolean | null

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function sortedByKind(criteria: WorkItem['criteria']): WorkItem['criteria'] {
  return [...criteria].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'inclusion' ? -1 : 1))
}

function defaultAnswerForKind(kind: string): boolean {
  return kind === 'inclusion'
}

export function ScreeningPage() {
  const { projectId = '', stage = 'title_abstract' } = useParams()
  const [item, setItem] = useState<WorkItem | null>(null)
  const [answers, setAnswers] = useState<Record<string, CriterionAnswer>>({})
  const [outcome, setOutcome] = useState('include')
  const [reasonId, setReasonId] = useState('')
  const [notes, setNotes] = useState('')
  const [queueEmpty, setQueueEmpty] = useState(false)
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetail>(`/api/v1/projects/${projectId}`),
  })
  const next = useMutation({
    mutationFn: () => apiRequest<WorkItem | null>(
      `/api/v1/projects/${projectId}/screening/${stage}/next`,
      { method: 'POST' },
    ),
    onSuccess: (result) => {
      setItem(result)
      setQueueEmpty(result === null)
    },
  })
  const submit = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No screening item is open')
      return apiRequest(
        `/api/v1/projects/${projectId}/screening/work-items/${item.id}/decision`,
        {
        method: 'POST',
        body: JSON.stringify({
          outcome,
          criteriaAnswers: answers,
          exclusionReasonId: outcome === 'exclude' ? reasonId : null,
          notes: notes || null,
        }),
        },
      )
    },
    onSuccess: () => {
      setItem(null)
      setAnswers({})
      setOutcome('include')
      setReasonId('')
      setNotes('')
      next.mutate()
    },
  })

  const autoFetchKey = useRef<string | null>(null)
  useEffect(() => {
    const key = `${projectId}:${stage}`
    if (autoFetchKey.current !== key) {
      autoFetchKey.current = key
      next.mutate()
    }
  }, [projectId, stage, next])

  useEffect(() => {
    if (item) {
      const draftAnswers = item.draft.criteriaAnswers
      const existing = typeof draftAnswers === 'object' && draftAnswers !== null
        ? draftAnswers as Record<string, CriterionAnswer>
        : {}
      const initial = Object.fromEntries(
        item.criteria.map((criterion) => [
          criterion.id,
          existing[criterion.id] ?? defaultAnswerForKind(criterion.kind),
        ]),
      )
      setAnswers(initial)
    }
  }, [item])

  const reasons = project.data?.exclusionReasons.filter(
    (reason) => reason.stage === stage,
  ) ?? []
  const criteriaComplete = item?.criteria.every(
    (criterion) => answers[criterion.id] !== null
      && answers[criterion.id] !== undefined,
  ) ?? false
  const canSubmit = criteriaComplete && (outcome !== 'exclude' || Boolean(reasonId))

  return (
    <main className="page">
      <h1>
        {stage === 'full_text'
          ? 'Full-text screening'
          : 'Title and abstract screening'}
      </h1>
      {!item ? (
        <>
          {next.isPending ? <p>Loading the next publication…</p> : null}
          {queueEmpty && !next.isPending ? <p>No publications are currently available.</p> : null}
          {next.error ? (
            <p className="error" role="alert">{next.error.message}</p>
          ) : null}
        </>
      ) : (
        <article className="card">
          <h2>{item.publication.title}</h2>
          <p>{item.publication.authors ?? 'Unknown authors'}</p>
          <p>{item.publication.abstract ?? 'No abstract available.'}</p>
          <div className="toolbar">
            {item.publication.doi ? (
              <a
                href={`https://doi.org/${item.publication.doi}`}
                target="_blank"
                rel="noreferrer"
              >
                Open DOI
              </a>
            ) : null}
            {item.publication.publisherUrl ? (
              <a
                href={item.publication.publisherUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open publisher page
              </a>
            ) : null}
          </div>
          <h3>Criteria</h3>
          <table className="criteria-table">
            <thead>
              <tr>
                <th scope="col">Criterion</th>
                <th scope="col">Fulfilled</th>
                <th scope="col">Not fulfilled</th>
              </tr>
            </thead>
            <tbody>
              {sortedByKind(item.criteria).map((criterion) => (
                <tr key={criterion.id}>
                  <th scope="row">{capitalize(criterion.kind)}: {criterion.text}</th>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${capitalize(criterion.kind)}: ${criterion.text} — Fulfilled`}
                      checked={answers[criterion.id] === true}
                      onChange={(event) => setAnswers((current) => ({
                        ...current,
                        [criterion.id]: event.target.checked ? true : null,
                      }))}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${capitalize(criterion.kind)}: ${criterion.text} — Not fulfilled`}
                      checked={answers[criterion.id] === false}
                      onChange={(event) => setAnswers((current) => ({
                        ...current,
                        [criterion.id]: event.target.checked ? false : null,
                      }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <label>
            Decision
            <select
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
            >
              <option value="include">Include</option>
              <option value="exclude">Exclude</option>
              <option value="uncertain">Uncertain</option>
              <option value="duplicate">Duplicate</option>
            </select>
          </label>
          {outcome === 'exclude' ? (
            <label>
              Exclusion reason
              <select
                value={reasonId}
                onChange={(event) => setReasonId(event.target.value)}
                required
              >
                <option value="">Select a reason</option>
                {reasons.map((reason) => (
                  <option value={reason.id} key={reason.id}>{reason.label}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            Notes
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          {!criteriaComplete ? (
            <p className="muted">Answer every criterion before submitting.</p>
          ) : null}
          {submit.error ? (
            <p className="error" role="alert">{submit.error.message}</p>
          ) : null}
          <button
            type="button"
            onClick={() => submit.mutate()}
            disabled={submit.isPending || !canSubmit}
          >
            Submit decision
          </button>
        </article>
      )}
    </main>
  )
}
