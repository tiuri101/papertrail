import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

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

/**
 * Same polling state machine as {@link usePendingJob}, for tracking several
 * background jobs kicked off by one action (e.g. one import batch per file
 * uploaded in a single multi-file submit). `onComplete` fires once every
 * tracked job has finished, with the full set of finished jobs.
 */
export function usePendingJobs(
  projectId: string | undefined,
  options: { onComplete?: (jobs: BackgroundJob[]) => void; clearOnComplete?: boolean } = {},
): {
  pendingJobIds: string[]
  setPendingJobIds: (ids: string[]) => void
  pendingJobs: BackgroundJob[]
} {
  const [pendingJobIds, setPendingJobIds] = useState<string[]>([])
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId) && pendingJobIds.length > 0,
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 2000 : false),
  })
  const pendingJobs = useMemo(
    () => pendingJobIds
      .map((id) => findJob(jobs.data, id))
      .filter((job): job is BackgroundJob => Boolean(job)),
    [jobs.data, pendingJobIds],
  )

  const onCompleteRef = useRef(options.onComplete)
  onCompleteRef.current = options.onComplete
  const clearOnComplete = options.clearOnComplete ?? true

  useEffect(() => {
    if (
      pendingJobIds.length > 0
      && pendingJobs.length === pendingJobIds.length
      && pendingJobs.every((job) => !isJobActive(job.status))
    ) {
      onCompleteRef.current?.(pendingJobs)
      if (clearOnComplete) setPendingJobIds([])
    }
  }, [pendingJobIds, pendingJobs, clearOnComplete])

  return { pendingJobIds, setPendingJobIds, pendingJobs }
}
