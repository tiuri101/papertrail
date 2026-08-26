import { useMutation, useQueryClient } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { isJobActive } from '../jobs/jobStatus'
import { usePendingJob } from '../jobs/usePendingJob'
import type { StageNarrative } from './types'
import { Button } from '../../components/Button'

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
    <div className="stage-narrative mt-6 rounded-md border border-[color-mix(in_srgb,var(--color-primary)_26%,var(--color-border))] bg-[radial-gradient(circle_at_100%_0,var(--color-primary-container),transparent_18rem),var(--color-bg-elevated)] p-5">
      <div className="stage-narrative__header flex items-center justify-between gap-4">
        <div>
          <span className="stage-narrative__eyebrow text-[0.7rem] font-[760] tracking-[0.1em] text-primary uppercase">AI-assisted insight</span>
          <h3 className="mt-1">Interpretation</h3>
        </div>
        <span className="stage-narrative__badge rounded-full border border-[color-mix(in_srgb,var(--color-primary)_35%,var(--color-border))] bg-primary-container px-[10px] py-[5px] text-[0.72rem] font-bold text-primary">Summary</span>
      </div>
      {narrative ? (
        <>
          {isStale ? (
            <p
              className="stale-banner rounded-md border border-[color-mix(in_srgb,var(--color-warning)_35%,transparent)] bg-warning-container px-4 py-3 font-[620] text-warning"
              role="status"
            >
              This summary may be outdated — the underlying results have changed since
              it was generated.
            </p>
          ) : null}
          <div className="stage-narrative__content mt-4 border-l-[3px] border-primary px-4 py-2">
            <p className="stage-narrative__summary m-0 max-w-[75ch] text-[0.95rem] leading-[1.7] text-text-secondary">{narrative.summary}</p>
            <span className="stage-narrative__timestamp mt-3 block text-[0.76rem] text-text-muted">
              Generated {new Date(narrative.generatedAt).toLocaleDateString()}
            </span>
          </div>
        </>
      ) : (
        <div className="stage-narrative__empty mt-4 rounded-sm border border-dashed border-border p-4 [&>p]:m-0">
          <p className="text-text">No summary generated yet.</p>
          <p className="stage-narrative__empty-hint !mt-2 text-[0.8rem] text-text-muted">Generate an interpretation to add context to the results above.</p>
        </div>
      )}
      {regenerate.error ? <p className="text-danger" role="alert">{regenerate.error.message}</p> : null}
      {pendingJob?.status === 'failed' ? (
        <p className="text-danger" role="alert">
          Summary generation failed{pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
        </p>
      ) : null}
      <div className="stage-narrative__footer mt-5 flex items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-start">
        <Button type="button" variant="secondary" onClick={() => regenerate.mutate()} disabled={isGenerating}>
        {isGenerating ? 'Generating…' : narrative ? 'Regenerate summary' : 'Generate summary'}
        </Button>
      </div>
    </div>
  )
}
