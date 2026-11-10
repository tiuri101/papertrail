import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../../api/client'
import { describeError } from '../../api/domainErrors'
import { DangerZoneConfirmButton, DangerZoneSection } from '../../components/DangerZoneSection'
import { IconRestart } from '../../components/icons'
import { Select } from '../../components/Select'
import { activeStages, humanizeStage, stageOrder, stages } from './lifecycleStages'
import { FieldLabel } from '../../components/FieldLabel'

export function MoveProjectBackPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [moveBackTarget, setMoveBackTarget] = useState(stages[1])
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<{ stage: string }>(`/projects/${projectId}`),
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

  if (!isActiveStage || !moveBackOptions.length) return null

  return (
    <DangerZoneSection
      id="section-move-project-back"
      title="Move Project Back"
      icon={<IconRestart />}
      description={
        <>
          Move an in-progress project back to an earlier stage. Screening decisions, duplicate
          merges, extraction responses, and quality-assessment data recorded in the target
          stage and every stage after it are permanently deleted, and the target stage is then
          regenerated fresh. Data from stages before the target, and project configuration
          (criteria, forms, members), are left untouched.
        </>
      }
    >
      {moveBack.error ? <p className="text-danger" role="alert">{describeError(moveBack.error)}</p> : null}
      <FieldLabel>
        Move back to
        <Select
          value={moveBackTarget}
          onChange={(event) => setMoveBackTarget(event.target.value)}
        >
          {moveBackOptions.map((stage) => <option key={stage} value={stage}>{humanizeStage(stage)}</option>)}
        </Select>
      </FieldLabel>
      <DangerZoneConfirmButton
        label="Move Project Back"
        confirmLabel="Move Back"
        warning="This permanently deletes screening decisions, extraction responses, and quality-assessment data recorded in the target stage and any stage after it. This cannot be undone."
        onConfirm={() => moveBack.mutate()}
        disabled={moveBack.isPending}
        icon={<IconRestart />}
      />
    </DangerZoneSection>
  )
}
