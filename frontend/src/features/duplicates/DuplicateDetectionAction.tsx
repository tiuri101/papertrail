import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
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
    <div className={`duplicate-detection-action${compact ? ' duplicate-detection-action--compact' : ''}`}>
      <Button
        type="button"
        variant="secondary"
        onClick={() => detection.mutate()}
        loading={detection.isPending}
      >
        {detection.isPending ? 'Queueing…' : 'Re-run Duplicate Detection'}
      </Button>
      {detection.isSuccess ? (
        <span className="success" role="status">
          {detectionJob?.status === 'completed'
            ? 'Duplicate detection finished. Results refreshed.'
            : 'Duplicate detection queued.'}
        </span>
      ) : null}
      {detection.error ? <span className="error" role="alert">{detection.error.message}</span> : null}
    </div>
  )
}
