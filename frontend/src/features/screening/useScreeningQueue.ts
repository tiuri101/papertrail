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
    id: string
    title: string
    authors: string | null
    abstract: string | null
    venue: string | null
    doi: string | null
    publisherUrl: string | null
  }
  criteria: ScreeningCriterion[]
  draft: Record<string, unknown>
}

interface ScreeningDecisionResponse {
  outcome: string
  criteriaAnswers?: Record<string, CriterionAnswer>
  notes?: string | null
}

interface SubmittedScreeningDecision {
  outcome: string
  criteriaAnswers: Record<string, CriterionAnswer>
  notes: string | null
}

export type CriterionAnswer = boolean | null

function defaultAnswerForKind(kind: string): boolean {
  return kind === 'inclusion'
}

function decisionsMatch(
  current: SubmittedScreeningDecision,
  submitted: SubmittedScreeningDecision,
): boolean {
  const currentKeys = Object.keys(current.criteriaAnswers)
  const submittedKeys = Object.keys(submitted.criteriaAnswers)
  return current.outcome === submitted.outcome
    && current.notes === submitted.notes
    && currentKeys.length === submittedKeys.length
    && currentKeys.every(
      (criterionId) => current.criteriaAnswers[criterionId] === submitted.criteriaAnswers[criterionId],
    )
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
  const [submitted, setSubmitted] = useState<{
    item: ScreeningWorkItem
    decision: SubmittedScreeningDecision
  } | null>(null)

  const next = useMutation({
    mutationFn: () => apiRequest<ScreeningWorkItem | null>(
      `/api/v1/projects/${projectId}/screening/${stage}/next`,
      { method: 'POST' },
    ),
    onSuccess: (result) => {
      setItem(result)
      setSubmitted(null)
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

  const continueAfterDecision = () => {
    setItem(null)
    setSubmitted(null)
    setAnswers({})
    setOutcome('include')
    setNotes('')
    fetchNext()
  }

  const submit = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No screening item is open')
      return apiRequest<ScreeningDecisionResponse>(
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
    onSuccess: (decision: ScreeningDecisionResponse) => {
      if (!item) return
      queryClient.invalidateQueries({ queryKey: progressQueryKey })
      // The full-text LLM suggestion is visible before submitting (unlike
      // title/abstract, which hides it until a first decision is in, to
      // avoid anchoring bias), so there's nothing new to reveal that would
      // warrant a second confirmation click here.
      if (stage === 'full_text') {
        continueAfterDecision()
        return
      }
      setSubmitted({
        item,
        decision: {
          outcome: decision.outcome ?? outcome,
          criteriaAnswers: decision.criteriaAnswers ?? answers,
          notes: decision.notes ?? (notes || null),
        },
      })
    },
  })

  const reviseDecision = useMutation({
    mutationFn: (revision: SubmittedScreeningDecision) => {
      if (!submitted) throw new Error('No submitted screening decision is open')
      return apiRequest<ScreeningDecisionResponse>(
        `/api/v1/projects/${projectId}/screening/work-items/${submitted.item.id}/decision`,
        {
          method: 'POST',
          body: JSON.stringify(revision),
        },
      )
    },
    onSuccess: (decision, revision) => {
      setSubmitted((current) => current ? {
        ...current,
        decision: {
          outcome: decision.outcome ?? revision.outcome,
          criteriaAnswers: decision.criteriaAnswers ?? revision.criteriaAnswers,
          notes: decision.notes ?? revision.notes,
        },
      } : null)
      queryClient.invalidateQueries({ queryKey: progressQueryKey })
    },
  })

  const confirmDecision = () => {
    if (!submitted) return
    const current = {
      outcome,
      criteriaAnswers: answers,
      notes: notes || null,
    }
    if (decisionsMatch(current, submitted.decision)) {
      continueAfterDecision()
      return
    }
    reviseDecision.mutate(current, { onSuccess: continueAfterDecision })
  }

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
    activeItemRef.current = submitted ? null : item
  }, [item, submitted])

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
    if (!item || submitted) return
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
  }, [item, projectId, answers, outcome, notes, submitted])

  const criteriaComplete = item?.criteria.every(
    (criterion) => answers[criterion.id] !== null
      && answers[criterion.id] !== undefined,
  ) ?? false

  return {
    projectId,
    stage,
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
    submitted,
    reviseDecision,
    confirmDecision,
  }
}

export type ScreeningQueue = ReturnType<typeof useScreeningQueue>
