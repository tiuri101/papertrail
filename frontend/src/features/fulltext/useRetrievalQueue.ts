import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'

export interface RetrievalPublication {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  doi: string | null
  publisherUrl: string | null
}

export interface Retrieval {
  id: string
  publicationId: string
  publication: RetrievalPublication
  status: string
  note: string | null
}

export interface RetrievalProgress {
  total: number
  addressed: number
}

// Papers aren't distributed to reviewers up front -- each one is claimed only
// once a reviewer actually asks for it (mirrors useScreeningQueue), so no two
// reviewers are ever shown the same paper to retrieve at the same time.
export function useRetrievalQueue(projectId: string) {
  const queryClient = useQueryClient()
  const progressQueryKey = ['fulltext-progress', projectId]
  const progress = useQuery({
    queryKey: progressQueryKey,
    queryFn: () => apiRequest<RetrievalProgress>(
      `/api/v1/projects/${projectId}/full-text/progress`,
    ),
    enabled: Boolean(projectId),
  })

  const [item, setItem] = useState<Retrieval | null>(null)
  const [loadingNext, setLoadingNext] = useState(true)
  const [nextError, setNextError] = useState<string | null>(null)
  // Purely local memory of "I've already passed on these" -- the server-side
  // claims for them were released the moment they were skipped, so these ids
  // exist only to keep the queue from immediately handing the same paper
  // back. Cleared when the queue runs dry, so a skipped paper does come round
  // again once everything else has been dealt with.
  const skippedRetrievalIds = useRef<Set<string>>(new Set())

  const nextUrl = () => {
    const params = new URLSearchParams()
    skippedRetrievalIds.current.forEach((id) => params.append('excludedRetrievalId', id))
    const query = params.toString()
    return `/api/v1/projects/${projectId}/full-text/next${query ? `?${query}` : ''}`
  }

  const next = useMutation({
    mutationFn: () => apiRequest<Retrieval | null>(
      nextUrl(),
      { method: 'POST' },
    ),
    onSuccess: (result) => {
      if (result === null && skippedRetrievalIds.current.size > 0) {
        skippedRetrievalIds.current.clear()
        next.mutate()
        return
      }
      setItem(result)
      setLoadingNext(false)
    },
    onError: (error) => {
      setNextError(error instanceof Error ? error.message : 'Failed to load the next publication')
      setLoadingNext(false)
    },
  })

  // Skipping releases the claim *now* rather than deferring it to component
  // teardown. A deferred release meant a reviewer who skipped five papers was
  // still holding five server-side claims -- invisible to everyone else --
  // until they navigated away, and anything that ended the session without a
  // clean unmount (a crash, a closed tab) stranded them until the lease
  // expired. Only once the release is acknowledged is the next item claimed,
  // so a failed release can never leave one reviewer holding two items.
  const skip = useMutation({
    mutationFn: async () => {
      const current = item
      if (!current) throw new Error('No retrieval is open')
      await apiRequest(
        `/api/v1/projects/${projectId}/full-text/${current.id}/release`,
        { method: 'POST' },
      )
      return current.id
    },
    onSuccess: (retrievalId) => {
      skippedRetrievalIds.current.add(retrievalId)
      setItem(null)
      fetchNext()
    },
    // No onError handler on purpose: the mutation's error is rendered on the
    // card and `item` is left in place, so the reviewer sees what failed and
    // can retry the same paper instead of silently moving on while the
    // server still believes they hold it.
  })

  const fetchNext = () => {
    setLoadingNext(true)
    setNextError(null)
    next.mutate()
  }

  // Submitting a status update resolves (or re-affirms) the claim server
  // side, so just move straight to the next claim rather than releasing
  // first -- the item is already accounted for.
  const advance = () => {
    setItem(null)
    queryClient.invalidateQueries({ queryKey: progressQueryKey })
    fetchNext()
  }

  const autoFetchKey = useRef<string | null>(null)
  useEffect(() => {
    if (autoFetchKey.current !== projectId) {
      autoFetchKey.current = projectId
      fetchNext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const activeItemRef = useRef<Retrieval | null>(null)
  useEffect(() => {
    activeItemRef.current = item
  }, [item])

  // Only the one item still open on teardown needs releasing; skipped items
  // were released as they were skipped.
  useEffect(() => () => {
    const abandoned = activeItemRef.current
    if (!abandoned) return
    apiRequest(
      `/api/v1/projects/${projectId}/full-text/${abandoned.id}/release`,
      { method: 'POST' },
    ).catch(() => {})
  }, [projectId])

  return {
    item,
    loadingNext,
    nextError,
    fetchNext,
    advance,
    skip,
    progress: progress.data,
  }
}
