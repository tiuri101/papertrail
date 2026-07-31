import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'

export interface ScreeningProgress {
  assigned: number
  completed: number
}

export interface ScreeningCriterion {
  id: string
  kind: string
  text: string
}

export interface ScreeningWorkItem {
  id: string
  publication: {
    title: string
    authors: string | null
    abstract: string | null
    doi: string | null
    publisherUrl: string | null
  }
  criteria: ScreeningCriterion[]
  draft: Record<string, unknown>
}

export type CriterionAnswer = boolean | null

function defaultAnswerForKind(kind: string): boolean {
  return kind === 'inclusion'
}

// React 18 StrictMode's double-invoked mount effects can desync
// useMutation's own isPending/status/error after mutate() is fired from an
// effect (not from a click handler), leaving the mutation looking
// perpetually "pending" even once onSuccess/onError have already run. Track
// loading/error state ourselves from those callbacks instead of reading it
// off the mutation object.
export function useScreeningQueue(projectId: string, stage: string) {
  const queryClient = useQueryClient()
  const progressQueryKey = ['screening-progress', projectId, stage]
  const progress = useQuery({
    queryKey: progressQueryKey,
    queryFn: () => apiRequest<ScreeningProgress>(
      `/api/v1/projects/${projectId}/screening/${stage}/progress`,
    ),
    enabled: Boolean(projectId),
  })

  const [item, setItem] = useState<ScreeningWorkItem | null>(null)
  const [answers, setAnswers] = useState<Record<string, CriterionAnswer>>({})
  const [outcome, setOutcome] = useState('include')
  const [notes, setNotes] = useState('')
  const [queueEmpty, setQueueEmpty] = useState(false)
  const [loadingNext, setLoadingNext] = useState(true)
  const [nextError, setNextError] = useState<string | null>(null)

  const next = useMutation({
    mutationFn: () => apiRequest<ScreeningWorkItem | null>(
      `/api/v1/projects/${projectId}/screening/${stage}/next`,
      { method: 'POST' },
    ),
    onSuccess: (result) => {
      setItem(result)
      setQueueEmpty(result === null)
      setLoadingNext(false)
    },
    onError: (error) => {
      setNextError(error instanceof Error ? error.message : 'Failed to load the next publication')
      setLoadingNext(false)
    },
  })

  const fetchNext = () => {
    setLoadingNext(true)
    setNextError(null)
    next.mutate()
  }

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
            notes: notes || null,
          }),
        },
      )
    },
    onSuccess: () => {
      setItem(null)
      setAnswers({})
      setOutcome('include')
      setNotes('')
      fetchNext()
      queryClient.invalidateQueries({ queryKey: progressQueryKey })
    },
  })

  const autoFetchKey = useRef<string | null>(null)
  useEffect(() => {
    const key = `${projectId}:${stage}`
    if (autoFetchKey.current !== key) {
      autoFetchKey.current = key
      fetchNext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, stage])

  const activeItemRef = useRef<ScreeningWorkItem | null>(null)
  useEffect(() => {
    activeItemRef.current = item
  }, [item])

  useEffect(() => {
    return () => {
      const abandoned = activeItemRef.current
      if (abandoned) {
        apiRequest(
          `/api/v1/projects/${projectId}/screening/work-items/${abandoned.id}/release`,
          { method: 'POST' },
        ).catch(() => {})
      }
    }
  }, [projectId, stage])

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
      if (typeof item.draft.outcome === 'string') setOutcome(item.draft.outcome)
      if (typeof item.draft.notes === 'string') setNotes(item.draft.notes)
    }
  }, [item])

  useEffect(() => {
    if (!item) return
    const shouldExclude = item.criteria.some((criterion) => (
      (criterion.kind === 'inclusion' && answers[criterion.id] === false)
      || (criterion.kind === 'exclusion' && answers[criterion.id] === true)
    ))
    if (shouldExclude) setOutcome('exclude')
  }, [answers, item])

  useEffect(() => {
    if (!item) return
    const timer = setTimeout(() => {
      apiRequest(
        `/api/v1/projects/${projectId}/screening/work-items/${item.id}/draft`,
        {
          method: 'PUT',
          body: JSON.stringify({
            draft: { criteriaAnswers: answers, outcome, notes },
          }),
        },
      ).catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [item, projectId, answers, outcome, notes])

  const criteriaComplete = item?.criteria.every(
    (criterion) => answers[criterion.id] !== null
      && answers[criterion.id] !== undefined,
  ) ?? false

  return {
    item,
    answers,
    setAnswers,
    outcome,
    setOutcome,
    notes,
    setNotes,
    queueEmpty,
    loadingNext,
    nextError,
    fetchNext,
    submit,
    criteriaComplete,
    progress: progress.data,
  }
}

export type ScreeningQueue = ReturnType<typeof useScreeningQueue>
