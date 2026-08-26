import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useId, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { FormField } from '../../components/FormField'
import { InfoBox } from '../../components/InfoBox'
import { Input } from '../../components/Input'
import { IconCheckCircle, IconSettings } from '../../components/icons'
import { Select } from '../../components/Select'
import { InfoTooltip } from '../../components/Tooltip'
import { Form } from '../../components/Form'
import { Fieldset } from '../../components/Fieldset'
import { structuralLockFrom } from '../../api/domainErrors'
import { LockableField } from './SettingsSaveBar'
import type { StructuralLocks } from './useStructuralSettingsForm'

type AllocationMode = 'independent' | 'divided' | 'claim'
type ResolutionMethod =
  | 'discussion_consensus'
  | 'admin_consensus'
  | 'additional_reviewer'
  | 'adjudicator'
  | 'majority'

interface ScreeningConfig {
  id: string
  stage: 'title_abstract' | 'full_text'
  requiredReviewers: number
  allocationMode: AllocationMode
  conflictResolution: ResolutionMethod
  uncertainResolution: ResolutionMethod
}

interface ProjectScreeningConfigs {
  id: string
  screeningConfigs: ScreeningConfig[]
}

interface Draft {
  requiredReviewers: string
  allocationMode: AllocationMode
  conflictResolution: ResolutionMethod
  uncertainResolution: ResolutionMethod
}

const STAGES: Array<{ value: ScreeningConfig['stage']; label: string }> = [
  { value: 'title_abstract', label: 'Title/Abstract Screening' },
  { value: 'full_text', label: 'Full-Text Screening' },
]

const ALLOCATION_MODE_LABELS: Record<AllocationMode, string> = {
  independent: 'Independent (every reviewer sees every publication)',
  divided: 'Divided (publications are pre-assigned to reviewers)',
  claim: 'Claim (reviewers pick up publications themselves)',
}

const RESOLUTION_METHOD_LABELS: Record<ResolutionMethod, string> = {
  discussion_consensus: 'Discussion consensus (reviewers discuss and agree)',
  admin_consensus: 'Admin/owner decides',
  additional_reviewer: 'Bring in an additional reviewer',
  adjudicator: 'Adjudicator decides',
  majority: 'Automatic majority vote',
}

function draftFrom(config: ScreeningConfig): Draft {
  return {
    requiredReviewers: String(config.requiredReviewers),
    allocationMode: config.allocationMode,
    conflictResolution: config.conflictResolution,
    uncertainResolution: config.uncertainResolution,
  }
}

function StageConfigForm({
  config,
  label,
  onSave,
  pending,
  error,
  locks,
  onDirtyChange,
}: {
  config: ScreeningConfig
  label: string
  onSave: (draft: Draft) => void
  pending: boolean
  error: Error | null
  locks: StructuralLocks
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(config))
  const fieldId = useId()

  useEffect(() => {
    setDraft(draftFrom(config))
  }, [config])

  useEffect(() => {
    const saved = draftFrom(config)
    onDirtyChange?.(
      draft.requiredReviewers !== saved.requiredReviewers
      || draft.allocationMode !== saved.allocationMode
      || draft.conflictResolution !== saved.conflictResolution
      || draft.uncertainResolution !== saved.uncertainResolution,
    )
  }, [draft, config, onDirtyChange])

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        onSave(draft)
      }}
    >
      <Fieldset>
        <legend className="mb-3 text-base font-semibold leading-[1.2] text-text">{label}</legend>
        <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <LockableField locked={locks.requiredReviewers}>
            <FormField label="Reviewers required per publication">
              <Input
                type="number"
                min={1}
                max={10}
                className="max-w-[6rem]"
                value={draft.requiredReviewers}
                disabled={Boolean(locks.requiredReviewers)}
                onChange={(event) => setDraft({ ...draft, requiredReviewers: event.target.value })}
                required
              />
            </FormField>
          </LockableField>
          <LockableField locked={locks.allocationMode}>
            <FormField
              label="Allocation"
              htmlFor={`${fieldId}-allocation`}
              accessory={(
                <InfoTooltip text="Independent: every reviewer screens every publication, and any disagreement becomes a conflict to resolve. Divided: publications are pre-assigned round-robin so each one is seen by only the required number of reviewers, which reduces workload but means fewer people double-check each decision. Claim: publications are left unassigned and reviewers pick them up themselves as they work, rather than being pre-assigned." />
              )}
            >
              <Select
                id={`${fieldId}-allocation`}
                value={draft.allocationMode}
                disabled={Boolean(locks.allocationMode)}
                onChange={(event) => setDraft({ ...draft, allocationMode: event.target.value as AllocationMode })}
              >
                {(Object.keys(ALLOCATION_MODE_LABELS) as AllocationMode[]).map((mode) => (
                  <option key={mode} value={mode}>{ALLOCATION_MODE_LABELS[mode]}</option>
                ))}
              </Select>
            </FormField>
          </LockableField>
          <FormField
            label="When reviewers disagree"
            htmlFor={`${fieldId}-conflict`}
            accessory={(
              <InfoTooltip text="How a publication is resolved when the required reviewers reach different include/exclude decisions on it — for example through discussion, an admin's ruling, an adjudicator, bringing in another reviewer, or an automatic majority vote." />
            )}
          >
            <Select
              id={`${fieldId}-conflict`}
              value={draft.conflictResolution}
              onChange={(event) => setDraft({ ...draft, conflictResolution: event.target.value as ResolutionMethod })}
            >
              {(Object.keys(RESOLUTION_METHOD_LABELS) as ResolutionMethod[]).map((method) => (
                <option key={method} value={method}>{RESOLUTION_METHOD_LABELS[method]}</option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="When a reviewer is uncertain"
            htmlFor={`${fieldId}-uncertain`}
            accessory={(
              <InfoTooltip text="How a publication is resolved when a reviewer marks their decision as uncertain instead of include or exclude, using the same set of resolution methods as a disagreement." />
            )}
          >
            <Select
              id={`${fieldId}-uncertain`}
              value={draft.uncertainResolution}
              onChange={(event) => setDraft({ ...draft, uncertainResolution: event.target.value as ResolutionMethod })}
            >
              {(Object.keys(RESOLUTION_METHOD_LABELS) as ResolutionMethod[]).map((method) => (
                <option key={method} value={method}>{RESOLUTION_METHOD_LABELS[method]}</option>
              ))}
            </Select>
          </FormField>
        </div>
        {error ? <p className="text-danger" role="alert">{error.message}</p> : null}
        <Button
            type="submit"
            disabled={pending}
            className="justify-self-start mt-4"
            startIcon={<IconCheckCircle />}
        >
          Save {label} Settings
        </Button>
      </Fieldset>
    </Form>
  )
}

export function ScreeningConfigPanel({
  projectId,
  onDirtyChange,
}: {
  projectId: string
  onDirtyChange?: (dirty: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [dirtyStages, setDirtyStages] = useState<Record<string, boolean>>({})
  // Which structural settings the backend has refused as locked, per stage.
  // The GET does not publish lock state, so a rejection is what the UI learns
  // from -- and the answer cannot revert while the stage's work items exist.
  const [locks, setLocks] = useState<Record<string, StructuralLocks>>({})
  useEffect(() => setLocks({}), [projectId])

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectScreeningConfigs>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  const save = useMutation({
    mutationFn: ({ stage, draft }: { stage: ScreeningConfig['stage']; draft: Draft }) =>
      apiRequest<ScreeningConfig>(`/api/v1/projects/${projectId}/screening-config/${stage}`, {
        method: 'PUT',
        body: JSON.stringify({
          requiredReviewers: Number(draft.requiredReviewers),
          allocationMode: draft.allocationMode,
          conflictResolution: draft.conflictResolution,
          uncertainResolution: draft.uncertainResolution,
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project', projectId] }),
    onError: (error, variables) => {
      const lock = structuralLockFrom(error)
      if (!lock) return
      setLocks((current) => ({
        ...current,
        [variables.stage]: { ...current[variables.stage], [lock.setting]: lock.message },
      }))
    },
  })

  const anyStageDirty = Object.values(dirtyStages).some(Boolean)
  useEffect(() => onDirtyChange?.(anyStageDirty), [anyStageDirty, onDirtyChange])

  if (project.isLoading) {
    return <CollapsibleSection id="section-screening-configuration" title="Screening Configuration" icon={<IconSettings />}><p>Loading…</p></CollapsibleSection>
  }
  if (project.isError || !project.data) {
    return (
      <CollapsibleSection id="section-screening-configuration" title="Screening Configuration" icon={<IconSettings />}>
        <p className="text-danger" role="alert">Screening configuration could not be loaded.</p>
      </CollapsibleSection>
    )
  }

  const configsByStage = new Map(project.data.screeningConfigs.map((config) => [config.stage, config]))

  return (
    <CollapsibleSection id="section-screening-configuration" title="Screening Configuration" icon={<IconSettings />}>
      <InfoBox icon={<IconSettings />}>
        <p>
          Set how many reviewers must independently screen each publication. Once every required
          reviewer has decided, publications where they didn&apos;t reach the same decision are
          marked as a conflict for resolution, unless automatic majority voting is selected.
        </p>
      </InfoBox>
      {STAGES.map(({ value, label }, index) => {
        const config = configsByStage.get(value)
        if (!config) return null
        return (
          <Fragment key={value}>
            {index > 0 ? <hr className="mt-5 border-0 border-t border-border" /> : null}
            <StageConfigForm
              config={config}
              label={label}
              pending={save.isPending && save.variables?.stage === value}
              error={save.error && save.variables?.stage === value ? save.error : null}
              locks={locks[value] ?? {}}
              onSave={(draft) => save.mutate({ stage: value, draft })}
              onDirtyChange={(stageDirty) => setDirtyStages((current) => (
                current[value] === stageDirty ? current : { ...current, [value]: stageDirty }
              ))}
            />
          </Fragment>
        )
      })}
    </CollapsibleSection>
  )
}
