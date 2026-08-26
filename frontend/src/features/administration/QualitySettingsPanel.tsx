import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import { IconCheckCircle } from '../../components/icons'
import {
  QUALITY_AGGREGATIONS,
  QUALITY_AGGREGATION_LABELS,
  QUALITY_MODES,
  QUALITY_MODE_LABELS,
  type QualityAggregation,
  type QualityConfig,
  type QualityMode,
} from '../quality/types'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { FieldLabel } from '../../components/FieldLabel'
import { LockableField, SettingsSaveBar } from './SettingsSaveBar'
import { useStructuralSettingsForm } from './useStructuralSettingsForm'

type TaskAllocationMode = QualityConfig['allocationMode']

const TASK_ALLOCATION_MODE_LABELS: Record<TaskAllocationMode, string> = {
  claim: 'Claim (reviewers pick up publications themselves)',
  pre_assigned: 'Pre-assigned (publications are split across reviewers)',
}

export function QualitySettingsPanel({ projectId }: { projectId: string }) {
  const form = useStructuralSettingsForm<QualityConfig, QualityConfig>({
    projectId,
    queryKey: 'quality-config',
    resource: 'quality-config',
    toDraft: (config) => ({
      enabled: config.enabled ?? false,
      mode: config.mode ?? 'both',
      aggregation: config.aggregation ?? 'sum',
      allocationMode: config.allocationMode ?? 'claim',
    }),
  })
  const { draft, change, locks } = form

  return (
    <CollapsibleSection id="section-quality-assessment-settings" title="Quality Assessment Settings" icon={<IconCheckCircle />}>
      <InfoBox icon={<IconCheckCircle />}>
        <p>Configure whether reviewers assess methodological quality and how numerical scores are combined.</p>
      </InfoBox>
      {form.loadError ? <p className="text-danger" role="alert">{form.loadError.message}</p> : null}
      {form.isLoading || !draft ? <p>Loading…</p> : (
        <>
          <div className="quality-settings-fields grid gap-5" data-quality-settings>
            <FieldLabel inline>
              <Input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => change({ enabled: event.target.checked })}
              />
              Enable quality assessment
            </FieldLabel>
            <div className="quality-settings-selects grid grid-cols-2 gap-4 max-[560px]:grid-cols-1" data-quality-settings-selects>
              <LockableField locked={locks.mode}>
                <FieldLabel>
                  Mode
                  <Select
                    value={draft.mode}
                    disabled={Boolean(locks.mode)}
                    onChange={(event) => change({ mode: event.target.value as QualityMode })}
                  >
                    {QUALITY_MODES.map((value) => (
                      <option key={value} value={value}>{QUALITY_MODE_LABELS[value]}</option>
                    ))}
                  </Select>
                </FieldLabel>
              </LockableField>
              <LockableField locked={locks.aggregation}>
                <FieldLabel>
                  Aggregation
                  <Select
                    value={draft.aggregation}
                    disabled={Boolean(locks.aggregation)}
                    onChange={(event) => change({ aggregation: event.target.value as QualityAggregation })}
                  >
                    {QUALITY_AGGREGATIONS.map((value) => (
                      <option key={value} value={value}>{QUALITY_AGGREGATION_LABELS[value]}</option>
                    ))}
                  </Select>
                </FieldLabel>
              </LockableField>
              <LockableField locked={locks.allocationMode}>
                <FieldLabel>
                  Allocation
                  <Select
                    value={draft.allocationMode}
                    disabled={Boolean(locks.allocationMode)}
                    onChange={(event) => change({ allocationMode: event.target.value as TaskAllocationMode })}
                  >
                    {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                      <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
                    ))}
                  </Select>
                </FieldLabel>
              </LockableField>
            </div>
          </div>
          {form.saveError ? <p className="text-danger" role="alert">{form.saveError.message}</p> : null}
          <SettingsSaveBar
            status={form.status}
            dirty={form.dirty}
            onSave={form.submit}
            onRevert={form.revert}
          />
        </>
      )}
    </CollapsibleSection>
  )
}
