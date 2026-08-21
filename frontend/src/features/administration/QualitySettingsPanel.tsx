import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import { IconCheckCircle } from '../../components/icons'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'

type TaskAllocationMode = 'pre_assigned' | 'claim'

interface QualityConfig {
  enabled: boolean
  mode: string
  aggregation: string
  allocationMode: TaskAllocationMode
}

const TASK_ALLOCATION_MODE_LABELS: Record<TaskAllocationMode, string> = {
  claim: 'Claim (reviewers pick up publications themselves)',
  pre_assigned: 'Pre-assigned (publications are split across reviewers)',
}

export function QualitySettingsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState('both')
  const [aggregation, setAggregation] = useState('sum')
  const [allocationMode, setAllocationMode] = useState<TaskAllocationMode>('claim')
  const seeded = useRef(false)
  const config = useQuery({
    queryKey: ['quality-config', projectId],
    queryFn: () => apiRequest<QualityConfig>(`/api/v1/projects/${projectId}/quality-config`),
    enabled: Boolean(projectId),
  })

  useEffect(() => {
    if (!config.data || seeded.current) return
    seeded.current = true
    setEnabled(config.data.enabled ?? false)
    setMode(config.data.mode ?? 'both')
    setAggregation(config.data.aggregation ?? 'sum')
    setAllocationMode(config.data.allocationMode ?? 'claim')
  }, [config.data])

  const save = useMutation({
    mutationFn: (next: QualityConfig) => apiRequest(
      `/api/v1/projects/${projectId}/quality-config`,
      { method: 'PUT', body: JSON.stringify(next) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quality-config', projectId] }),
  })
  const update = (next: QualityConfig) => {
    setEnabled(next.enabled)
    setMode(next.mode)
    setAggregation(next.aggregation)
    setAllocationMode(next.allocationMode)
    if (seeded.current) save.mutate(next)
  }

  return (
    <CollapsibleSection id="section-quality-assessment-settings" title="Quality Assessment Settings" icon={<IconCheckCircle />}>
      <InfoBox icon={<IconCheckCircle />}>
        <p>Configure whether reviewers assess methodological quality and how numerical scores are combined.</p>
      </InfoBox>
      {config.error ? <p className="text-danger" role="alert">{config.error.message}</p> : null}
      {config.isLoading ? <p>Loadingâ€¦</p> : (
        <div data-quality-settings="true" className="grid gap-5">
          <label>
            <Input
              type="checkbox"
              checked={enabled}
              onChange={(event) => update({ enabled: event.target.checked, mode, aggregation, allocationMode })}
            />
            Enable quality assessment
          </label>
          <div data-quality-settings-selects="true" className="grid grid-cols-1 gap-4 min-[561px]:grid-cols-2">
            <label>
              Mode
              <Select
                value={mode}
                onChange={(event) => update({ enabled, mode: event.target.value, aggregation, allocationMode })}
              >
                <option value="qualitative">Qualitative only</option>
                <option value="numeric">Numerical scoring only</option>
                <option value="both">Both</option>
              </Select>
            </label>
            <label>
              Aggregation
              <Select
                value={aggregation}
                onChange={(event) => update({ enabled, mode, aggregation: event.target.value, allocationMode })}
              >
                <option value="sum">Simple sum</option>
                <option value="average">Average</option>
                <option value="weighted_average">Weighted average</option>
              </Select>
            </label>
            <label>
              Allocation
              <Select
                value={allocationMode}
                onChange={(event) => update({
                  enabled, mode, aggregation, allocationMode: event.target.value as TaskAllocationMode,
                })}
              >
                {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                  <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
                ))}
              </Select>
            </label>
          </div>
        </div>
      )}
      {save.error ? <p className="text-danger" role="alert">{save.error.message}</p> : null}
      {save.isPending || save.isSuccess ? <p className="text-text-muted" aria-live="polite">
        {save.isPending ? 'Savingâ€¦' : save.isSuccess ? 'Saved.' : ' '}
      </p> : null}
    </CollapsibleSection>
  )
}
