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
  const skippedRetrievalIds = useRef<Set<string>>(new Set())
  const deferredClaimIds = useRef<Set<string>>(new Set())

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
      if (result) deferredClaimIds.current.delete(result.id)
      setItem(result)
      setLoadingNext(false)
    },
    onError: (error) => {
      setNextError(error instanceof Error ? error.message : 'Failed to load the next publication')
      setLoadingNext(false)
    },
  })

  const skip = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No retrieval is open')
      return Promise.resolve(item.id)
    },
    onSuccess: (retrievalId) => {
      skippedRetrievalIds.current.add(retrievalId)
      deferredClaimIds.current.add(retrievalId)
      setItem(null)
      fetchNext()
    },
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

  useEffect(() => {
    const deferredIds = deferredClaimIds.current
    return () => {
      const abandoned = activeItemRef.current
      const abandonedIds = new Set(deferredIds)
      if (abandoned) abandonedIds.add(abandoned.id)
      abandonedIds.forEach((retrievalId) => {
        apiRequest(
          `/api/v1/projects/${projectId}/full-text/${retrievalId}/release`,
          { method: 'POST' },
        ).catch(() => {})
      })
    }
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
