import { useMutation, useQueryClient } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { isJobActive } from '../jobs/jobStatus'
import { usePendingJob } from '../jobs/usePendingJob'
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
  const { setPendingJobId, pendingJob } = usePendingJob(projectId, {
    onComplete: () => queryClient.invalidateQueries({ queryKey: ['analysis', projectId, stage] }),
  })

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
        <button type="button" className="button-secondary" onClick={() => regenerate.mutate()} disabled={isGenerating}>
        {isGenerating ? 'Generating…' : narrative ? 'Regenerate summary' : 'Generate summary'}
        </button>
      </div>
    </div>
  )
}
