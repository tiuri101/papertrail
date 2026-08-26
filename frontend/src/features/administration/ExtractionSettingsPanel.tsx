import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import { IconDownload } from '../../components/icons'
import { Select } from '../../components/Select'
import { FieldLabel } from '../../components/FieldLabel'
import { LockableField, SettingsSaveBar } from './SettingsSaveBar'
import { useStructuralSettingsForm } from './useStructuralSettingsForm'

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
  const form = useStructuralSettingsForm<ExtractionConfig, ExtractionConfig>({
    projectId,
    queryKey: 'extraction-config',
    resource: 'extraction-config',
    toDraft: (config) => ({
      allocationMode: config.allocationMode ?? 'claim',
      requiredReviewers: config.requiredReviewers ?? 1,
    }),
  })
  const { draft, change, locks } = form

  return (
    <CollapsibleSection id="section-extraction-settings" title="Extraction Settings" icon={<IconDownload />}>
      <InfoBox icon={<IconDownload />}>
        <p>Configure how publications are handed out to reviewers for data extraction.</p>
      </InfoBox>
      {form.loadError ? <p className="text-danger" role="alert">{form.loadError.message}</p> : null}
      {form.isLoading || !draft ? <p>Loading…</p> : (
        <>
          <LockableField locked={locks.requiredReviewers}>
            <FieldLabel>
              Extractors per publication
              <Select
                value={draft.requiredReviewers}
                disabled={Boolean(locks.requiredReviewers)}
                onChange={(event) => change({ requiredReviewers: Number(event.target.value) })}
              >
                {[1, 2].map((value) => (
                  <option key={value} value={value}>{REQUIRED_REVIEWERS_LABELS[value].title}</option>
                ))}
              </Select>
            </FieldLabel>
          </LockableField>
          <p className="text-text-muted">{REQUIRED_REVIEWERS_LABELS[draft.requiredReviewers]?.description}</p>
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
