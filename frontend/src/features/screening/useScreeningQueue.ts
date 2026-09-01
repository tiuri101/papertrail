import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import {
  lastScreeningKey,
  loadLastCompletedItem,
  saveLastCompletedItem,
  type LastCompletedItem,
} from '../../lib/lastCompletedItem'

export interface ScreeningProgress {
  assigned: number
  completed: number
  remaining: number
  claimMode: boolean
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
    publicationYear: number | null
    venue: string | null
    doi: string | null
    publisherUrl: string | null
  }
  criteria: ScreeningCriterion[]
  draft: Record<string, unknown>
  llmAssistanceEnabled: boolean
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

export interface PreviousScreeningDecision {
  id: string
  outcome: string
  criteriaAnswers: Record<string, boolean>
  notes: string | null
  version: number
}

export interface PreviousScreeningItem {
  id: string
  publication: ScreeningWorkItem['publication']
  criteria: ScreeningCriterion[]
  decision: PreviousScreeningDecision | null
}

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
  const skippedItemIds = useRef<Set<string>>(new Set())
  const [lastCompletedItem, setLastCompletedItem] = useState<LastCompletedItem | null>(
    () => (projectId ? loadLastCompletedItem(lastScreeningKey(projectId, stage)) : null),
  )
  const [previousItem, setPreviousItem] = useState<PreviousScreeningItem | null>(null)

  const nextUrl = () => {
    const params = new URLSearchParams()
    skippedItemIds.current.forEach((id) => params.append('excludedItemId', id))
    const query = params.toString()
    return `/api/v1/projects/${projectId}/screening/${stage}/next${query ? `?${query}` : ''}`
  }

  const next = useMutation({
    mutationFn: () => apiRequest<ScreeningWorkItem | null>(
      nextUrl(),
      { method: 'POST' },
    ),
    onSuccess: (result) => {
      if (result === null && skippedItemIds.current.size > 0) {
        skippedItemIds.current.clear()
        next.mutate()
        return
      }
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

  const skip = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('No screening item is open')
      await apiRequest(
        `/api/v1/projects/${projectId}/screening/work-items/${item.id}/release`,
        { method: 'POST' },
      )
      return item.id
    },
    onSuccess: (itemId) => {
      skippedItemIds.current.add(itemId)
      setItem(null)
      setAnswers({})
      setOutcome('include')
      setNotes('')
      fetchNext()
    },
  })

  const fetchNext = () => {
    setLoadingNext(true)
    setNextError(null)
    next.mutate()
  }

  const continueAfterDecision = () => {
    const finishedItem = submitted?.item ?? item
    if (finishedItem) {
      const completed = { id: finishedItem.id, title: finishedItem.publication.title }
      setLastCompletedItem(completed)
      saveLastCompletedItem(lastScreeningKey(projectId, stage), completed)
    }
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
      // Both stages hide the LLM suggestion until a first decision is in, to
      // avoid anchoring bias — so submitting reveals something new that's
      // worth a second confirmation click. When LLM assistance is off for
      // this stage, no suggestion is ever shown, so there's nothing to
      // reveal and nothing to confirm against.
      if (!item.llmAssistanceEnabled) {
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

  const goBack = useMutation({
    mutationFn: () => {
      if (!lastCompletedItem) throw new Error('No previous paper to go back to')
      return apiRequest<PreviousScreeningItem>(
        `/api/v1/projects/${projectId}/screening/work-items/${lastCompletedItem.id}`,
      )
    },
    onSuccess: (result) => setPreviousItem(result),
  })

  const closePrevious = () => setPreviousItem(null)

  const savePreviousDecision = useMutation({
    mutationFn: (revision: SubmittedScreeningDecision) => {
      if (!previousItem) throw new Error('No previous paper is open')
      return apiRequest<PreviousScreeningDecision>(
        `/api/v1/projects/${projectId}/screening/work-items/${previousItem.id}/decision`,
        { method: 'POST', body: JSON.stringify(revision) },
      )
    },
    onSuccess: (decision) => {
      setPreviousItem((current) => (current ? { ...current, decision } : null))
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
    skip,
    criteriaComplete,
    progress: progress.data,
    submitted,
    reviseDecision,
    confirmDecision,
    lastCompletedItem,
    previousItem,
    goBack,
    closePrevious,
    savePreviousDecision,
  }
}

export type ScreeningQueue = ReturnType<typeof useScreeningQueue>
