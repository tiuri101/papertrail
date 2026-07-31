import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'

const stages = [
  'draft',
  'duplicate_review',
  'title_abstract_screening',
  'full_text_screening',
  'extraction_quality',
]

const activeStages = stages.filter((stage) => stage !== 'draft')

export function ProjectLifecyclePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [targetStage, setTargetStage] = useState(stages[2])
  const [moveBackTarget, setMoveBackTarget] = useState(stages[1])
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<{ stage: string }>(`/projects/${projectId}`),
  })
  const integrity = useQuery({
    queryKey: ['project-integrity', projectId],
    queryFn: () => api<{ issues: Array<{ code: string; message: string }> }>(
      `/projects/${projectId}/integrity`,
    ),
  })
  const markReady = useMutation({
    mutationFn: () => api(`/projects/${projectId}/ready`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-dashboard', projectId] })
    },
  })
  const reopen = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ targetStage }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  })
  const moveBack = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/move-back`, {
        method: 'POST',
        body: JSON.stringify({ targetStage: moveBackTarget }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-dashboard', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-integrity', projectId] })
    },
  })
  const currentStage = project.data?.stage
  const currentIndex = currentStage ? stages.indexOf(currentStage) : -1
  const isActiveStage = currentStage
    ? currentStage !== 'draft' && currentStage !== 'completed'
    : false
  const moveBackOptions = activeStages.filter(
    (stage) => stages.indexOf(stage) < currentIndex,
  )

  return (
    <section className="card">
      {project.data?.stage === 'draft' ? (
        <>
          <h2>Start the review</h2>
          <p>Once your research questions, criteria, and screening configuration are set, mark the project ready to move it into duplicate review and detect duplicate publications among your imports.</p>
          {markReady.error ? <p className="error" role="alert">{markReady.error.message}</p> : null}
          <button
            type="button"
            onClick={() => markReady.mutate()}
            disabled={markReady.isPending}
          >
            Mark project ready
          </button>
        </>
      ) : null}
      <h2>Workflow integrity</h2>
      {integrity.data?.issues.length ? (
        <ul>
          {integrity.data.issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : <p>No consistency issues detected.</p>}
      <label>
        Reopen completed project at
        <select
          value={targetStage}
          onChange={(event) => setTargetStage(event.target.value)}
        >
          {stages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
        </select>
      </label>
      <button
        type="button"
        onClick={() => reopen.mutate()}
        disabled={reopen.isPending}
      >
        Reopen project
      </button>
      {isActiveStage && moveBackOptions.length ? (
        <>
          <h2>Move project back</h2>
          <p>Move an in-progress project back to an earlier stage without deleting any screening, extraction, or quality-assessment data already recorded. That data is kept for traceability but excluded from active workflow counts until the project reaches that stage again.</p>
          {moveBack.error ? <p className="error" role="alert">{moveBack.error.message}</p> : null}
          <label>
            Move back to
            <select
              value={moveBackTarget}
              onChange={(event) => setMoveBackTarget(event.target.value)}
            >
              {moveBackOptions.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
            </select>
          </label>
          <ConfirmButton
            label="Move project back"
            confirmLabel="Move back"
            warning="This moves the project to an earlier stage. Downstream data (screening decisions, extraction, quality assessment) is kept, not deleted, but will no longer count toward the active stage until the project advances again."
            onConfirm={() => moveBack.mutate()}
            disabled={moveBack.isPending}
          />
        </>
      ) : null}
    </section>
  )
}
