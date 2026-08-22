import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'

interface ReviewWorkItem<TResponse> {
  id: string
  draft: Record<string, unknown>
  currentResponse: TResponse | null
}

/**
 * Shared "load the next work item" queue mechanics for the extraction and quality workspaces:
 * fetch a specific item (`itemId` route) or claim the next unclaimed one, skip/release an item
 * back to the queue, autosave the in-progress draft, and scroll a new item into view. Submission
 * itself stays in each workspace — the request bodies and response shapes genuinely differ.
 */
export function useReviewWorkQueue<TItem extends ReviewWorkItem<TResponse>, TResponse>({
  baseUrl,
  itemId,
  variant,
  loadErrorFallback,
}: {
  /** e.g. `/api/v1/projects/${projectId}/extraction` or `.../quality`, with no trailing slash. */
  baseUrl: string
  itemId?: string
  /** 'inline' skips the scroll-into-view behavior, matching the caller's own chrome decision. */
  variant: 'page' | 'inline'
  loadErrorFallback: string
}) {
  const [item, setItem] = useState<TItem | null>(null)
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [queueEmpty, setQueueEmpty] = useState(false)
  const [loadingNext, setLoadingNext] = useState(true)
  const [nextError, setNextError] = useState<string | null>(null)
  const [completedResponse, setCompletedResponse] = useState<TResponse | null>(null)
  const skippedItemIds = useRef<Set<string>>(new Set())

  const next = useMutation({
    mutationFn: () => {
      if (itemId) return apiRequest<TItem>(`${baseUrl}/${itemId}`)
      const params = new URLSearchParams()
      skippedItemIds.current.forEach((id) => params.append('excludedItemId', id))
      const query = params.toString()
      return apiRequest<TItem | null>(`${baseUrl}/next${query ? `?${query}` : ''}`, { method: 'POST' })
    },
    onSuccess: (result) => {
      if (!itemId && result === null && skippedItemIds.current.size > 0) {
        skippedItemIds.current.clear()
        next.mutate()
        return
      }
      setItem(result)
      setAnswers(result?.draft ?? {})
      setCompletedResponse(result?.currentResponse ?? null)
      setQueueEmpty(!itemId && result === null)
      setLoadingNext(false)
    },
    onError: (error) => {
      setNextError(error instanceof Error ? error.message : loadErrorFallback)
      setLoadingNext(false)
    },
  })
  // See TitleAbstractScreeningPage.tsx for why loading/error state is tracked locally
  // instead of read off next.isPending/next.error.
  const fetchNext = () => {
    setLoadingNext(true)
    setNextError(null)
    next.mutate()
  }

  const skip = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('No item is open')
      await apiRequest(`${baseUrl}/${item.id}/release`, { method: 'POST' })
      return item.id
    },
    onSuccess: (skippedId) => {
      skippedItemIds.current.add(skippedId)
      setItem(null)
      setAnswers({})
      fetchNext()
    },
  })

  /** Clears the current item and answers, then claims the next one — used after a submit that isn't tied to a fixed `itemId`. */
  const resetAndFetchNext = () => {
    setItem(null)
    setAnswers({})
    setCompletedResponse(null)
    fetchNext()
  }

  const autoFetchKey = useRef<string | null>(null)
  useEffect(() => {
    const key = `${baseUrl}:${itemId ?? 'next'}`
    if (autoFetchKey.current !== key) {
      autoFetchKey.current = key
      fetchNext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, itemId])

  const titleRef = useRef<HTMLHeadingElement>(null)
  const visibleItemId = item?.id
  useEffect(() => {
    if (variant !== 'inline' && visibleItemId) titleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [variant, visibleItemId])

  useEffect(() => {
    if (!item || completedResponse) return
    const timer = setTimeout(() => {
      apiRequest(`${baseUrl}/${item.id}/draft`, { method: 'PUT', body: JSON.stringify({ draft: answers }) }).catch(() => {})
    }, 1000)
    return () => clearTimeout(timer)
  }, [item, baseUrl, answers, completedResponse])

  return {
    item,
    answers,
    setAnswers,
    queueEmpty,
    loadingNext,
    nextError,
    completedResponse,
    setCompletedResponse,
    fetchNext,
    skip,
    resetAndFetchNext,
    titleRef,
  }
}
