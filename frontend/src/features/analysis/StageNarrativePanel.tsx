import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { type BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'
import type { StageNarrative } from './types'

export function StageNarrativePanel({
  projectId,
  stage,
  narrative,
  isStale,
}: {
  projectId: string
  stage: string
  narrative: StageNarrative | null
  isStale: boolean
}) {
  const queryClient = useQueryClient()
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId) && Boolean(pendingJobId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 2000 : false),
  })
  const pendingJob = pendingJobId ? findJob(jobs.data, pendingJobId) : undefined

  useEffect(() => {
    if (pendingJob && !isJobActive(pendingJob.status)) {
      queryClient.invalidateQueries({ queryKey: ['analysis', projectId, stage] })
      setPendingJobId(null)
    }
  }, [pendingJob, projectId, stage, queryClient])

  const regenerate = useMutation({
    mutationFn: () => apiRequest<{ jobId: string }>(
      `/api/v1/projects/${projectId}/analysis/${stage}/regenerate`,
      { method: 'POST' },
    ),
    onSuccess: (result) => setPendingJobId(result.jobId),
  })

  const isGenerating = Boolean(pendingJob && isJobActive(pendingJob.status)) || regenerate.isPending

  return (
    <div className="stage-narrative">
      <div className="stage-narrative__header">
        <div>
          <span className="stage-narrative__eyebrow">AI-assisted insight</span>
          <h3>Interpretation</h3>
        </div>
        <span className="stage-narrative__badge">Summary</span>
      </div>
      {narrative ? (
        <>
          {isStale ? (
            <p className="stale-banner" role="status">
              This summary may be outdated — the underlying results have changed since
              it was generated.
            </p>
          ) : null}
          <div className="stage-narrative__content">
            <p className="stage-narrative__summary">{narrative.summary}</p>
            <span className="stage-narrative__timestamp">
              Generated {new Date(narrative.generatedAt).toLocaleDateString()}
            </span>
          </div>
        </>
      ) : (
        <div className="stage-narrative__empty">
          <p className="muted">No summary generated yet.</p>
          <p className="stage-narrative__empty-hint">Generate an interpretation to add context to the results above.</p>
        </div>
      )}
      {regenerate.error ? <p className="error" role="alert">{regenerate.error.message}</p> : null}
      {pendingJob?.status === 'failed' ? (
        <p className="error" role="alert">
          Summary generation failed{pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
        </p>
      ) : null}
      <div className="stage-narrative__footer">
        <Button type="button" variant="secondary" onClick={() => regenerate.mutate()} disabled={isGenerating}>
        {isGenerating ? 'Generating…' : narrative ? 'Regenerate summary' : 'Generate summary'}
        </Button>
      </div>
    </div>
  )
}
