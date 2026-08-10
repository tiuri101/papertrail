import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { InfoBox } from '../../components/InfoBox'
import { IconCheckCircle, IconRestart } from '../../components/icons'
import { activeStages, humanizeStage, stageOrder, stages } from './lifecycleStages'

export function ProjectLifecyclePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
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
  const moveBackOptions = activeStages.filter(
    (stage) => stageOrder.indexOf(stage) < currentIndex,
  )

  return (
    <>
      <CollapsibleSection
        id="section-workflow-integrity"
        title="Workflow Integrity"
        icon={<IconCheckCircle />}
      >
        <InfoBox icon={<IconCheckCircle />}>
          <p>
            Automated checks for inconsistencies across a project's stages, such as decisions or
            data left over from a stage the project has already moved past. These checks run
            automatically whenever this page loads and don&apos;t block your work — they just
            flag things worth a second look.
          </p>
        </InfoBox>
        {integrity.data?.issues.length ? (
          <ul>
            {integrity.data.issues.map((issue) => (
              <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        ) : <p>No consistency issues detected.</p>}
      </CollapsibleSection>
      {isActiveStage && moveBackOptions.length ? (
        <CollapsibleSection id="section-move-project-back" title="Move Project Back" icon={<IconRestart />}>
          <InfoBox icon={<IconRestart />}>
            <p>
              Move an in-progress project back to an earlier stage without deleting any screening, extraction, or quality-assessment data already recorded. That data is kept for traceability but excluded from active workflow counts until the project reaches that stage again. Only shown
              while a project is still active — once a project reaches Completed, use Reopen at an Earlier Stage instead.
            </p>
          </InfoBox>
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
