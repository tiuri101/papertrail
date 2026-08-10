import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconRestart } from '../../components/icons'
import { InfoTooltip } from '../../components/Tooltip'

const stages = [
  'draft',
  'duplicate_review',
  'title_abstract_screening',
  'full_text_screening',
  'extraction_quality',
]

const stageOrder = [...stages, 'completed']

const activeStages = stages.filter((stage) => stage !== 'draft')

function humanizeStage(stage: string): string {
  return stage
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

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
  const currentIndex = currentStage ? stageOrder.indexOf(currentStage) : -1
  const isActiveStage = currentStage
    ? currentStage !== 'draft' && currentStage !== 'completed'
    : false
  const isCompleted = currentStage === 'completed'
  const reopenOptions = stages.filter(
    (stage) => stageOrder.indexOf(stage) < currentIndex,
  )
  const moveBackOptions = activeStages.filter(
    (stage) => stageOrder.indexOf(stage) < currentIndex,
  )

  return (
    <>
      <CollapsibleSection id="section-workflow-integrity" title="Workflow Integrity">
        <p className="muted">
          Automated checks for inconsistencies across a project's stages, such as decisions or
          data left over from a stage the project has already moved past.
          <InfoTooltip text="These checks run automatically whenever this page loads. They don't block your work — they just flag things worth a second look." />
        </p>
        {integrity.data?.issues.length ? (
          <ul>
            {integrity.data.issues.map((issue) => (
              <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        ) : <p>No consistency issues detected.</p>}
      </CollapsibleSection>
      {isCompleted && reopenOptions.length ? (
        <CollapsibleSection id="section-reopen-project" title="Reopen Project">
          <p>
            Move a completed project back to an earlier stage to resume work. Screening, extraction, and quality-assessment data already recorded is kept, not deleted.
            <InfoTooltip text="Only shown once a project has reached Completed. If the project is still active, use Move Project Back instead." />
          </p>
          {reopen.error ? <p className="error" role="alert">{reopen.error.message}</p> : null}
          <label>
            Move back to
            <select
              value={targetStage}
              onChange={(event) => setTargetStage(event.target.value)}
            >
              {reopenOptions.map((stage) => <option key={stage} value={stage}>{humanizeStage(stage)}</option>)}
            </select>
          </label>
          <ConfirmButton
            label="Reopen Project"
            confirmLabel="Reopen"
            warning="This reopens the project at the selected stage. Downstream data (screening decisions, extraction, quality assessment) is kept, not deleted, but will no longer count toward the active stage until the project advances again."
            onConfirm={() => reopen.mutate()}
            disabled={reopen.isPending}
            icon={<IconRestart />}
          />
        </CollapsibleSection>
      ) : null}
      {isActiveStage && moveBackOptions.length ? (
        <CollapsibleSection id="section-move-project-back" title="Move Project Back">
          <p>
            Move an in-progress project back to an earlier stage without deleting any screening, extraction, or quality-assessment data already recorded. That data is kept for traceability but excluded from active workflow counts until the project reaches that stage again.
            <InfoTooltip text="Only shown while a project is still active (not yet completed). Once a project reaches Completed, use Reopen Project instead." />
          </p>
          {moveBack.error ? <p className="error" role="alert">{moveBack.error.message}</p> : null}
          <label>
            Move back to
            <select
              value={moveBackTarget}
              onChange={(event) => setMoveBackTarget(event.target.value)}
            >
              {moveBackOptions.map((stage) => <option key={stage} value={stage}>{humanizeStage(stage)}</option>)}
            </select>
          </label>
          <ConfirmButton
            label="Move Project Back"
            confirmLabel="Move Back"
            warning="This moves the project to an earlier stage. Downstream data (screening decisions, extraction, quality assessment) is kept, not deleted, but will no longer count toward the active stage until the project advances again."
            onConfirm={() => moveBack.mutate()}
            disabled={moveBack.isPending}
          />
        </CollapsibleSection>
      ) : null}
    </>
  )
}
