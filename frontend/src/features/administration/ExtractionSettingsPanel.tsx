import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import { IconDownload } from '../../components/icons'

type TaskAllocationMode = 'pre_assigned' | 'claim'

interface ExtractionConfig {
  allocationMode: TaskAllocationMode
}

const TASK_ALLOCATION_MODE_LABELS: Record<TaskAllocationMode, string> = {
  claim: 'Claim (reviewers pick up publications themselves)',
  pre_assigned: 'Pre-assigned (publications are split across reviewers)',
}

export function ExtractionSettingsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [allocationMode, setAllocationMode] = useState<TaskAllocationMode>('claim')
  const seeded = useRef(false)
  const config = useQuery({
    queryKey: ['extraction-config', projectId],
    queryFn: () => apiRequest<ExtractionConfig>(`/api/v1/projects/${projectId}/extraction-config`),
    enabled: Boolean(projectId),
  })

  useEffect(() => {
    if (!config.data || seeded.current) return
    seeded.current = true
    setAllocationMode(config.data.allocationMode ?? 'claim')
  }, [config.data])

  const save = useMutation({
    mutationFn: (next: ExtractionConfig) => apiRequest(
      `/api/v1/projects/${projectId}/extraction-config`,
      { method: 'PUT', body: JSON.stringify(next) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['extraction-config', projectId] }),
  })
  const update = (next: TaskAllocationMode) => {
    setAllocationMode(next)
    if (seeded.current) save.mutate({ allocationMode: next })
  }

  return (
    <CollapsibleSection id="section-extraction-settings" title="Extraction Settings" icon={<IconDownload />}>
      <InfoBox icon={<IconDownload />}>
        <p>Configure how publications are handed out to reviewers for data extraction.</p>
      </InfoBox>
      {config.error ? <p className="error" role="alert">{config.error.message}</p> : null}
      {config.isLoading ? <p>Loading…</p> : (
        <label>
          Allocation
          <select
            value={allocationMode}
            onChange={(event) => update(event.target.value as TaskAllocationMode)}
          >
            {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
              <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
            ))}
          </select>
        </label>
      )}
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <p className="muted" aria-live="polite">
        {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ' '}
      </p>
    </CollapsibleSection>
  )
}
