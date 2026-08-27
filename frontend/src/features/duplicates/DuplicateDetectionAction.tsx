import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { cn } from '../../lib/cn'
import { type BackgroundJob, findJob, isJobActive } from '../jobs/jobStatus'

interface DetectionJob {
  jobId: string
  status: string
}

export function DuplicateDetectionAction({
  projectId,
  compact = false,
}: {
  projectId: string
  compact?: boolean
}) {
  const queryClient = useQueryClient()
  const [detectionJobId, setDetectionJobId] = useState<string | null>(null)
  const refreshedJobId = useRef<string | null>(null)
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId && detectionJobId),
    refetchInterval: (query) => {
      if (!detectionJobId) return false
      const job = findJob(query.state.data, detectionJobId)
      return !job || isJobActive(job.status) ? 2000 : false
    },
  })
  const detectionJob = detectionJobId ? findJob(jobs.data, detectionJobId) : undefined

  useEffect(() => {
    if (
      !detectionJobId
      || detectionJob?.status !== 'completed'
      || refreshedJobId.current === detectionJobId
    ) return

    refreshedJobId.current = detectionJobId
    queryClient.invalidateQueries({ queryKey: ['duplicates', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-checklist', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-jobs-summary', projectId] })
  }, [detectionJob?.status, detectionJobId, projectId, queryClient])

  const detection = useMutation({
    mutationFn: () => apiRequest<DetectionJob>(
      `/api/v1/projects/${projectId}/duplicates/detect`,
      { method: 'POST' },
    ),
    onSuccess: (job) => {
      refreshedJobId.current = null
      setDetectionJobId(job.jobId)
      queryClient.invalidateQueries({ queryKey: ['project-checklist', projectId] })
      queryClient.invalidateQueries({ queryKey: ['jobs', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-jobs-summary', projectId] })
    },
  })

  return (
    <div className={cn('flex flex-wrap items-center gap-3 [&_.text-danger]:m-0 [&_.text-success]:m-0', !compact && 'mb-5')}>
      <Button
        type="button"
        variant="secondary"
        onClick={() => detection.mutate()}
        loading={detection.isPending}
      >
        {detection.isPending ? 'Queueing…' : 'Re-run Duplicate Detection'}
      </Button>
      {detection.isSuccess ? (
        <span className="text-success" role="status">
          {detectionJob?.status === 'completed'
            ? 'Duplicate detection finished. Results refreshed.'
            : 'Duplicate detection queued.'}
        </span>
      ) : null}
      {detection.error ? <span className="text-danger" role="alert">{detection.error.message}</span> : null}
    </div>
  )
}

interface AssessmentJob {
  jobId: string
  status: string
}

/**
 * Re-runs only the external assist for the current unresolved pairs — URL
 * reachability + Crossref / Semantic Scholar — without the (slower) blocking
 * detection pass. Manager-only, shown during duplicate review.
 */
export function DuplicateAssessmentAction({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [assessmentJobId, setAssessmentJobId] = useState<string | null>(null)
  const refreshedJobId = useRef<string | null>(null)
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId && assessmentJobId),
    refetchInterval: (query) => {
      if (!assessmentJobId) return false
      const job = findJob(query.state.data, assessmentJobId)
      return !job || isJobActive(job.status) ? 2000 : false
    },
  })
  const assessmentJob = assessmentJobId ? findJob(jobs.data, assessmentJobId) : undefined

  useEffect(() => {
    if (
      !assessmentJobId
      || assessmentJob?.status !== 'completed'
      || refreshedJobId.current === assessmentJobId
    ) return
    refreshedJobId.current = assessmentJobId
    queryClient.invalidateQueries({ queryKey: ['duplicates', projectId] })
  }, [assessmentJob?.status, assessmentJobId, projectId, queryClient])

  const assessment = useMutation({
    mutationFn: () => apiRequest<AssessmentJob>(
      `/api/v1/projects/${projectId}/duplicates/assess`,
      { method: 'POST' },
    ),
    onSuccess: (job) => {
      refreshedJobId.current = null
      setAssessmentJobId(job.jobId)
      queryClient.invalidateQueries({ queryKey: ['jobs', projectId] })
    },
  })

  return (
    <div className="flex flex-wrap items-center gap-3 [&_.text-danger]:m-0 [&_.text-success]:m-0">
      <Button
        type="button"
        variant="secondary"
        onClick={() => assessment.mutate()}
        loading={assessment.isPending}
      >
        {assessment.isPending ? 'Queueing…' : 'Re-check links & providers'}
      </Button>
      {assessment.isSuccess ? (
        <span className="text-success" role="status">
          {assessmentJob?.status === 'completed'
            ? 'Assessment finished. Suggestions refreshed.'
            : 'Assessment queued.'}
        </span>
      ) : null}
      {assessment.error ? <span className="text-danger" role="alert">{assessment.error.message}</span> : null}
    </div>
  )
}
