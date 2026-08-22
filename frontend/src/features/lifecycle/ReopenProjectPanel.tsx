import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { api } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconAlertTriangle, IconRestart } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Select } from '../../components/Select'
import { humanizeStage, stageOrder, stages } from './lifecycleStages'

export function ReopenProjectPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [targetStage, setTargetStage] = useState(stages[2])
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api<{ stage: string }>(`/projects/${projectId}`),
  })
  const reopen = useMutation({
    mutationFn: () =>
      api(`/projects/${projectId}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ targetStage }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
  })
  const currentStage = project.data?.stage
  const currentIndex = currentStage ? stageOrder.indexOf(currentStage) : -1
  const isCompleted = currentStage === 'completed'
  const reopenOptions = stages.filter((stage) => stageOrder.indexOf(stage) < currentIndex)

  if (!isCompleted || reopenOptions.length === 0) return null

  return (
    <CollapsibleSection id="section-reopen-project" title="Reopen at an Earlier Stage" tone="danger" icon={<IconRestart />}>
      <InfoBox icon={<IconAlertTriangle />} tone="warning">
        <p>
          Move a completed project back to an earlier stage to resume work. Screening, extraction, and quality-assessment data already recorded is kept, not deleted. Only shown once a project
          has reached Completed.
        </p>
      </InfoBox>
      {reopen.error ? <p className="text-danger" role="alert">{reopen.error.message}</p> : null}
      <label>
        Reopen at
        <Select
          value={targetStage}
          onChange={(event) => setTargetStage(event.target.value)}
        >
          {reopenOptions.map((stage) => <option key={stage} value={stage}>{humanizeStage(stage)}</option>)}
        </Select>
      </label>
      <ConfirmButton
        label="Reopen Project"
        confirmLabel="Reopen"
        warning="Are you sure you want to continue? This cannot be undone."
        onConfirm={() => reopen.mutate()}
        disabled={reopen.isPending}
        variant="danger"
        icon={<IconRestart />}
      />
    </CollapsibleSection>
  )
}
