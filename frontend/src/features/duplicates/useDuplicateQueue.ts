import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import {
  lastDuplicateKey,
  loadLastCompletedItem,
  saveLastCompletedItem,
  type LastCompletedItem,
} from '../../lib/lastCompletedItem'
import type { Candidate, DuplicateProgress } from './types'

// A lighter cousin of useScreeningQueue: duplicate review is not partitioned
// per reviewer and has no drafts or criteria, so the queue is just "claim the
// next unreserved pair, decide, advance". The server-side reservation lease
// (see claim_next_duplicate) keeps two reviewers off the same pair; this hook
// only tracks the pair currently on screen plus a client-side skip set.
export function useDuplicateQueue(projectId: string) {
  const queryClient = useQueryClient()
  const progressQueryKey = ['duplicate-progress', projectId]
  const progress = useQuery({
    queryKey: progressQueryKey,
    queryFn: () => apiRequest<DuplicateProgress>(
      `/api/v1/projects/${projectId}/duplicates/progress`,
    ),
    enabled: Boolean(projectId),
  })

  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [queueEmpty, setQueueEmpty] = useState(false)
  const [loadingNext, setLoadingNext] = useState(true)
  const [nextError, setNextError] = useState<string | null>(null)
  const skippedIds = useRef<Set<string>>(new Set())
  const [lastCompletedItem, setLastCompletedItem] = useState<LastCompletedItem | null>(
    () => (projectId ? loadLastCompletedItem(lastDuplicateKey(projectId)) : null),
  )
  const [previousCandidate, setPreviousCandidate] = useState<Candidate | null>(null)

  const nextUrl = () => {
    const params = new URLSearchParams()
    skippedIds.current.forEach((id) => params.append('excludedItemId', id))
    const query = params.toString()
    return `/api/v1/projects/${projectId}/duplicates/next${query ? `?${query}` : ''}`
  }

  const next = useMutation({
    mutationFn: () => apiRequest<Candidate | null>(nextUrl(), { method: 'POST' }),
    onSuccess: (result) => {
      if (result === null && skippedIds.current.size > 0) {
        skippedIds.current.clear()
        next.mutate()
        return
      }
      setCandidate(result)
      setQueueEmpty(result === null)
      setLoadingNext(false)
    },
    onError: (error) => {
      setNextError(error instanceof Error ? error.message : 'Failed to load the next duplicate pair')
      setLoadingNext(false)
    },
  })

  const fetchNext = () => {
    setLoadingNext(true)
    setNextError(null)
    next.mutate()
  }

  const afterResolved = () => {
    if (candidate) {
      const completed = { id: candidate.id, title: candidate.publicationA.title }
      setLastCompletedItem(completed)
      saveLastCompletedItem(lastDuplicateKey(projectId), completed)
    }
    setCandidate(null)
    queryClient.invalidateQueries({ queryKey: progressQueryKey })
    queryClient.invalidateQueries({ queryKey: ['duplicates', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-checklist', projectId] })
    fetchNext()
  }

  const merge = useMutation({
    mutationFn: (canonicalPublicationId: string) => {
      if (!candidate) throw new Error('No duplicate pair is open')
      return apiRequest(
        `/api/v1/projects/${projectId}/duplicates/${candidate.id}/merge`,
        { method: 'POST', body: JSON.stringify({ canonicalPublicationId }) },
      )
    },
    onSuccess: afterResolved,
  })

  const notDuplicate = useMutation({
    mutationFn: () => {
      if (!candidate) throw new Error('No duplicate pair is open')
      return apiRequest(
        `/api/v1/projects/${projectId}/duplicates/${candidate.id}/not-duplicate`,
        { method: 'POST', body: JSON.stringify({ note: null }) },
      )
    },
    onSuccess: afterResolved,
  })

  const skip = useMutation({
    mutationFn: async () => {
      if (!candidate) throw new Error('No duplicate pair is open')
      await apiRequest(
        `/api/v1/projects/${projectId}/duplicates/${candidate.id}/release`,
        { method: 'POST' },
      )
      return candidate.id
    },
    onSuccess: (id) => {
      skippedIds.current.add(id)
      setCandidate(null)
      fetchNext()
    },
  })

  const goBack = useMutation({
    mutationFn: async () => {
      if (!lastCompletedItem) throw new Error('No previous pair to go back to')
      const all = await apiRequest<Candidate[]>(
        `/api/v1/projects/${projectId}/duplicates`,
      )
      const found = all.find((entry) => entry.id === lastCompletedItem.id)
      if (!found) throw new Error('That duplicate pair is no longer available')
      return found
    },
    onSuccess: (found) => setPreviousCandidate(found),
  })

  const closePrevious = () => setPreviousCandidate(null)

  const onPreviousRevised = (updated: Candidate) => {
    setPreviousCandidate(updated)
    queryClient.invalidateQueries({ queryKey: progressQueryKey })
    queryClient.invalidateQueries({ queryKey: ['duplicates', projectId] })
  }

  const autoFetchKey = useRef<string | null>(null)
  useEffect(() => {
    if (autoFetchKey.current !== projectId) {
      autoFetchKey.current = projectId
      fetchNext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const openCandidateRef = useRef<Candidate | null>(null)
  useEffect(() => {
    openCandidateRef.current = candidate
  }, [candidate])

  useEffect(() => {
    return () => {
      const abandoned = openCandidateRef.current
      if (abandoned) {
        apiRequest(
          `/api/v1/projects/${projectId}/duplicates/${abandoned.id}/release`,
          { method: 'POST' },
        ).catch(() => {})
      }
    }
  }, [projectId])

  return {
    projectId,
    candidate,
    queueEmpty,
    loadingNext,
    nextError,
    fetchNext,
    merge,
    notDuplicate,
    skip,
    progress: progress.data,
    lastCompletedItem,
    previousCandidate,
    goBack,
    closePrevious,
    onPreviousRevised,
  }
}

export type DuplicateQueue = ReturnType<typeof useDuplicateQueue>
