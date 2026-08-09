import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconCheckCircle } from '../../components/icons'

type AllocationMode = 'independent' | 'divided'
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
  divided: 'Divided (publications are split across reviewers)',
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
  onDirtyChange,
}: {
  config: ScreeningConfig
  label: string
  onSave: (draft: Draft) => void
  pending: boolean
  error: Error | null
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(config))

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
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSave(draft)
      }}
    >
      <fieldset>
        <legend className="subsection-heading">{label}</legend>
        <label>
          Reviewers required per publication
          <input
            type="number"
            min={1}
            max={10}
            value={draft.requiredReviewers}
            onChange={(event) => setDraft({ ...draft, requiredReviewers: event.target.value })}
            required
          />
        </label>
        <label>
          Allocation
          <select
            value={draft.allocationMode}
            onChange={(event) => setDraft({ ...draft, allocationMode: event.target.value as AllocationMode })}
          >
            {(Object.keys(ALLOCATION_MODE_LABELS) as AllocationMode[]).map((mode) => (
              <option key={mode} value={mode}>{ALLOCATION_MODE_LABELS[mode]}</option>
            ))}
          </select>
        </label>
        <label>
          When reviewers disagree
          <select
            value={draft.conflictResolution}
            onChange={(event) => setDraft({ ...draft, conflictResolution: event.target.value as ResolutionMethod })}
          >
            {(Object.keys(RESOLUTION_METHOD_LABELS) as ResolutionMethod[]).map((method) => (
              <option key={method} value={method}>{RESOLUTION_METHOD_LABELS[method]}</option>
            ))}
          </select>
        </label>
        <label>
          When a reviewer is uncertain
          <select
            value={draft.uncertainResolution}
            onChange={(event) => setDraft({ ...draft, uncertainResolution: event.target.value as ResolutionMethod })}
          >
            {(Object.keys(RESOLUTION_METHOD_LABELS) as ResolutionMethod[]).map((method) => (
              <option key={method} value={method}>{RESOLUTION_METHOD_LABELS[method]}</option>
            ))}
          </select>
        </label>
        {error ? <p className="error" role="alert">{error.message}</p> : null}
        <button type="submit" disabled={pending}><IconCheckCircle />Save {label} Settings</button>
      </fieldset>
    </form>
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
  })

  const anyStageDirty = Object.values(dirtyStages).some(Boolean)
  useEffect(() => onDirtyChange?.(anyStageDirty), [anyStageDirty, onDirtyChange])

  if (project.isLoading) {
    return <CollapsibleSection id="section-screening-configuration" title="Screening Configuration"><p>Loading…</p></CollapsibleSection>
  }
  if (project.isError || !project.data) {
    return (
      <CollapsibleSection id="section-screening-configuration" title="Screening Configuration">
        <p className="error" role="alert">Screening configuration could not be loaded.</p>
      </CollapsibleSection>
    )
  }

  const configsByStage = new Map(project.data.screeningConfigs.map((config) => [config.stage, config]))

  return (
    <CollapsibleSection id="section-screening-configuration" title="Screening Configuration">
      <p className="muted">
        Set how many reviewers must independently screen each publication. Once every required
        reviewer has decided, publications where they didn&apos;t reach the same decision are
        marked as a conflict for resolution, unless automatic majority voting is selected.
      </p>
      {STAGES.map(({ value, label }) => {
        const config = configsByStage.get(value)
        if (!config) return null
        return (
          <StageConfigForm
            key={value}
            config={config}
            label={label}
            pending={save.isPending && save.variables?.stage === value}
            error={save.error && save.variables?.stage === value ? save.error : null}
            onSave={(draft) => save.mutate({ stage: value, draft })}
            onDirtyChange={(stageDirty) => setDirtyStages((current) => (
              current[value] === stageDirty ? current : { ...current, [value]: stageDirty }
            ))}
          />
        )
      })}
    </CollapsibleSection>
  )
}
