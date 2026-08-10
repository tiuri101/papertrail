import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'

interface QualityConfig {
  enabled: boolean
  mode: string
  aggregation: string
}

export function QualitySettingsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState('both')
  const [aggregation, setAggregation] = useState('sum')
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
    if (seeded.current) save.mutate(next)
  }

  return (
    <CollapsibleSection id="section-quality-assessment-settings" title="Quality Assessment Settings">
      <p className="muted">
        Configure whether reviewers assess methodological quality and how numerical scores are combined.
      </p>
      {config.error ? <p className="error" role="alert">{config.error.message}</p> : null}
      {config.isLoading ? <p>Loadingâ€¦</p> : (
        <div className="quality-settings-fields">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => update({ enabled: event.target.checked, mode, aggregation })}
            />
            Enable quality assessment
          </label>
          <div className="quality-settings-selects">
            <label>
              Mode
              <select
                value={mode}
                onChange={(event) => update({ enabled, mode: event.target.value, aggregation })}
              >
                <option value="qualitative">Qualitative only</option>
                <option value="numeric">Numerical scoring only</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label>
              Aggregation
              <select
                value={aggregation}
                onChange={(event) => update({ enabled, mode, aggregation: event.target.value })}
              >
                <option value="sum">Simple sum</option>
                <option value="average">Average</option>
                <option value="weighted_average">Weighted average</option>
              </select>
            </label>
          </div>
        </div>
      )}
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <p className="muted" aria-live="polite">
        {save.isPending ? 'Savingâ€¦' : save.isSuccess ? 'Saved.' : ' '}
      </p>
    </CollapsibleSection>
  )
}
