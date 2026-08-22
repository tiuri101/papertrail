import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { type BackgroundJob, findJob, hasActiveJob, isJobActive } from './jobStatus'

/**
 * Shared polling state machine for a single "pending background job" tracked by id.
 *
 * While a job id is pending, polls `/api/v1/projects/:projectId/jobs` every 2s (only while
 * that job is actually active) and resolves the matching `BackgroundJob` record. Once the
 * tracked job is no longer active, `onComplete` fires with the finished job.
 *
 * By default the pending job id is cleared once the job completes/fails, so the polling query
 * goes back to disabled. Pass `clearOnComplete: false` to keep the last known job (and its
 * status) around after completion instead — some callers keep showing the finished job's state
 * inline rather than resetting to an empty "no pending job" view.
 */
export function usePendingJob(
  projectId: string | undefined,
  options: { onComplete?: (job: BackgroundJob) => void; clearOnComplete?: boolean } = {},
): {
  pendingJobId: string | null
  setPendingJobId: (id: string | null) => void
  pendingJob: BackgroundJob | undefined
} {
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId) && Boolean(pendingJobId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 2000 : false),
  })
  const pendingJob = pendingJobId ? findJob(jobs.data, pendingJobId) : undefined

  const onCompleteRef = useRef(options.onComplete)
  onCompleteRef.current = options.onComplete
  const clearOnComplete = options.clearOnComplete ?? true

  useEffect(() => {
    if (pendingJob && !isJobActive(pendingJob.status)) {
      onCompleteRef.current?.(pendingJob)
      if (clearOnComplete) setPendingJobId(null)
    }
  }, [pendingJob, clearOnComplete])

  return { pendingJobId, setPendingJobId, pendingJob }
}
