import { useMutation, useQueryClient } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'

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
  const detection = useMutation({
    mutationFn: () => apiRequest<DetectionJob>(
      `/api/v1/projects/${projectId}/duplicates/detect`,
      { method: 'POST' },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['duplicates', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-checklist', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-jobs', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-jobs-summary', projectId] })
    },
  })

  return (
    <div className={`duplicate-detection-action${compact ? ' duplicate-detection-action--compact' : ''}`}>
      <button
        type="button"
        className="button-secondary"
        onClick={() => detection.mutate()}
        disabled={detection.isPending}
      >
        {detection.isPending ? 'Queueing…' : 'Re-run Duplicate Detection'}
      </button>
      {detection.isSuccess ? <span className="success" role="status">Duplicate detection queued.</span> : null}
      {detection.error ? <span className="error" role="alert">{detection.error.message}</span> : null}
    </div>
  )
}
