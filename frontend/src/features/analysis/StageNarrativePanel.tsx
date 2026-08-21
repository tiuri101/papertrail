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
    <div className="mt-6 rounded-lg border border-[color:color-mix(in_srgb,var(--color-primary)_26%,var(--color-border))] bg-[radial-gradient(circle_at_100%_0,var(--color-primary-container),transparent_18rem)] bg-surface-elevated p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <span className="text-[0.7rem] font-bold tracking-[0.1em] text-primary uppercase">AI-assisted insight</span>
          <h3 className="mt-1">Interpretation</h3>
        </div>
        <span className="rounded-full border border-[color:color-mix(in_srgb,var(--color-primary)_35%,var(--color-border))] bg-primary-container px-2.5 py-1.5 text-xs font-bold text-primary">Summary</span>
      </div>
      {narrative ? (
        <>
          {isStale ? (
            <p className="rounded-md border border-[color-mix(in_srgb,var(--color-warning)_35%,transparent)] bg-warning-container px-4 py-3 font-semibold text-warning" role="status">
              This summary may be outdated — the underlying results have changed since
              it was generated.
            </p>
          ) : null}
          <div className="mt-4 border-l-[3px] border-primary px-4 py-2">
            <p className="m-0 max-w-[75ch] text-[0.95rem] leading-[1.7] text-text-secondary">{narrative.summary}</p>
            <span className="mt-3 block text-xs text-text-muted">
              Generated {new Date(narrative.generatedAt).toLocaleDateString()}
            </span>
          </div>
        </>
      ) : (
        <div className="mt-4 rounded-md border border-dashed border-border p-4">
          <p className="m-0 text-text-muted">No summary generated yet.</p>
          <p className="mt-2 mb-0 text-[0.8rem] text-text-muted">Generate an interpretation to add context to the results above.</p>
        </div>
      )}
      {regenerate.error ? <p className="error" role="alert">{regenerate.error.message}</p> : null}
      {pendingJob?.status === 'failed' ? (
        <p className="error" role="alert">
          Summary generation failed{pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
        </p>
      ) : null}
      <div className="mt-5 flex items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-start">
        <Button type="button" variant="secondary" onClick={() => regenerate.mutate()} disabled={isGenerating}>
        {isGenerating ? 'Generating…' : narrative ? 'Regenerate summary' : 'Generate summary'}
        </Button>
      </div>
    </div>
  )
}
