import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { apiRequest } from '../../api/client'

export interface BrowserAgentSummary {
  id: string
  displayName: string
  lastSeenAt: string | null
  extensionVersion: string | null
}

export interface RetrievalBatchProgress {
  total: number
  queued: number
  active: number
  succeeded: number
  needsAuthentication: number
  notFound: number
  accessDenied: number
  invalidResponse: number
  failed: number
  cancelled: number
  skippedExisting: number
  processed: number
}

export interface RetrievalJobSummary {
  jobId: string
  publicationId: string
  title: string
  status: string
  errorCode: string | null
  errorMessage: string | null
  resolvedLandingUrl: string | null
}

export interface RetrievalBatch {
  id: string
  projectId: string
  status: 'running' | 'completed' | 'cancelled'
  createdAt: string
  completedAt: string | null
  cancelledAt: string | null
  progress: RetrievalBatchProgress
  attentionJobs: RetrievalJobSummary[]
  succeededPublicationIds: string[]
}

const POLL_INTERVAL_MS = 3000

export function useBrowserPdfRetrieval(projectId: string) {
  const queryClient = useQueryClient()

  const agents = useQuery({
    queryKey: ['browser-agents'],
    queryFn: () => apiRequest<BrowserAgentSummary[]>('/api/v1/browser-agents'),
    enabled: Boolean(projectId),
  })

  const missingCount = useQuery({
    queryKey: ['pdf-retrieval-missing-count', projectId],
    queryFn: () => apiRequest<{ missingCount: number }>(
      `/api/v1/projects/${projectId}/pdf-retrieval-batches/missing-count`,
    ),
    enabled: Boolean(projectId),
  })

  const batchesQueryKey = ['pdf-retrieval-batches', projectId]
  const batches = useQuery({
    queryKey: batchesQueryKey,
    queryFn: () => apiRequest<RetrievalBatch[]>(
      `/api/v1/projects/${projectId}/pdf-retrieval-batches`,
    ),
    enabled: Boolean(projectId),
  })

  const batchList = Array.isArray(batches.data) ? batches.data : []
  const activeBatch = batchList.find((batch) => batch.status === 'running') ?? null
  const latestBatch = activeBatch ?? batchList[0] ?? null

  const invalidateDownstreamQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['fulltext-progress', projectId] })
    queryClient.invalidateQueries({ queryKey: ['screening-progress', projectId, 'full_text'] })
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'full-text-document',
    })
    queryClient.invalidateQueries({ queryKey: ['pdf-retrieval-missing-count', projectId] })
  }

  // Poll the active batch's progress while browser retrieval is in flight,
  // and refresh the full-text/screening queues whenever new PDFs land so a
  // paper doesn't sit stale in the manual retrieval queue after the
  // extension already resolved it.
  const previousSucceeded = useRef(0)
  useEffect(() => {
    if (!activeBatch) return
    const interval = window.setInterval(() => {
      queryClient.invalidateQueries({ queryKey: batchesQueryKey })
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBatch?.id])

  useEffect(() => {
    const succeeded = latestBatch?.progress.succeeded ?? 0
    if (succeeded > previousSucceeded.current) {
      invalidateDownstreamQueries()
    }
    previousSucceeded.current = succeeded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestBatch?.progress.succeeded])

  const createBatch = useMutation({
    mutationFn: (publicationIds?: string[]) => apiRequest<{ batch: RetrievalBatch }>(
      `/api/v1/projects/${projectId}/pdf-retrieval-batches`,
      { method: 'POST', body: JSON.stringify({ publicationIds: publicationIds ?? null }) },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: batchesQueryKey })
      queryClient.invalidateQueries({ queryKey: ['pdf-retrieval-missing-count', projectId] })
    },
  })

  const cancelBatch = useMutation({
    mutationFn: (batchId: string) => apiRequest<RetrievalBatch>(
      `/api/v1/projects/${projectId}/pdf-retrieval-batches/${batchId}/cancel`,
      { method: 'POST' },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: batchesQueryKey }),
  })

  const retryFailed = useMutation({
    mutationFn: (batchId: string) => apiRequest<RetrievalBatch>(
      `/api/v1/projects/${projectId}/pdf-retrieval-batches/${batchId}/retry-failed`,
      { method: 'POST' },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: batchesQueryKey }),
  })

  return {
    agents,
    missingCount: missingCount.data?.missingCount ?? null,
    activeBatch,
    latestBatch,
    createBatch,
    cancelBatch,
    retryFailed,
  }
}
