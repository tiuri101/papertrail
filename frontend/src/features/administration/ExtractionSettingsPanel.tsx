import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import { IconDownload } from '../../components/icons'
import { Select } from '../../components/Select'

type TaskAllocationMode = 'pre_assigned' | 'claim'

interface ExtractionConfig {
  allocationMode: TaskAllocationMode
  requiredReviewers: number
}

const TASK_ALLOCATION_MODE_LABELS: Record<TaskAllocationMode, string> = {
  claim: 'Claim (reviewers pick up publications themselves)',
  pre_assigned: 'Pre-assigned (publications are split across reviewers)',
}

const REQUIRED_REVIEWERS_LABELS: Record<number, { title: string; description: string }> = {
  1: {
    title: 'Single extractor',
    description: 'One reviewer extracts each included publication; their submission is immediately the final result.',
  },
  2: {
    title: 'Two independent extractors',
    description: 'Two different reviewers independently extract each included publication. If their answers disagree, the publication is sent to reconciliation before a final result exists.',
  },
}

export function ExtractionSettingsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [allocationMode, setAllocationMode] = useState<TaskAllocationMode>('claim')
  const [requiredReviewers, setRequiredReviewers] = useState<number>(1)
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
    setRequiredReviewers(config.data.requiredReviewers ?? 1)
  }, [config.data])

  const save = useMutation({
    mutationFn: (next: ExtractionConfig) => apiRequest(
      `/api/v1/projects/${projectId}/extraction-config`,
      { method: 'PUT', body: JSON.stringify(next) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['extraction-config', projectId] }),
    onError: () => {
      // Revert the optimistic local value if the change was rejected (e.g.
      // extractors-per-publication can't change once work has begun) so the
      // control doesn't keep showing a value the backend didn't accept.
      if (config.data) {
        setAllocationMode(config.data.allocationMode)
        setRequiredReviewers(config.data.requiredReviewers)
      }
    },
  })
  const updateAllocationMode = (next: TaskAllocationMode) => {
    setAllocationMode(next)
    if (seeded.current) save.mutate({ allocationMode: next, requiredReviewers })
  }
  const updateRequiredReviewers = (next: number) => {
    setRequiredReviewers(next)
    if (seeded.current) save.mutate({ allocationMode, requiredReviewers: next })
  }

  return (
    <CollapsibleSection id="section-extraction-settings" title="Extraction Settings" icon={<IconDownload />}>
      <InfoBox icon={<IconDownload />}>
        <p>Configure how publications are handed out to reviewers for data extraction.</p>
      </InfoBox>
      {config.error ? <p className="error" role="alert">{config.error.message}</p> : null}
      {config.isLoading ? <p>Loading…</p> : (
        <>
          <label>
            Extractors per publication
            <Select
              value={requiredReviewers}
              onChange={(event) => updateRequiredReviewers(Number(event.target.value))}
            >
              {[1, 2].map((value) => (
                <option key={value} value={value}>{REQUIRED_REVIEWERS_LABELS[value].title}</option>
              ))}
            </Select>
          </label>
          <p className="muted">{REQUIRED_REVIEWERS_LABELS[requiredReviewers]?.description}</p>
          <label>
            Allocation
            <Select
              value={allocationMode}
              onChange={(event) => updateAllocationMode(event.target.value as TaskAllocationMode)}
            >
              {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
              ))}
            </Select>
          </label>
        </>
      )}
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      {save.isPending || save.isSuccess ? <p className="muted" aria-live="polite">
        {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ' '}
      </p> : null}
    </CollapsibleSection>
  )
}
