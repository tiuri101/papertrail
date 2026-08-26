import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import { IconLightbulb } from '../../components/icons'
import { Textarea } from '../../components/Textarea'

interface PromptFlow {
  key: string
  label: string
  basePrompt: string
  customInstructions: string
}

interface PromptSettingsResponse {
  flows: PromptFlow[]
}

interface PromptSettingsUpdate {
  extractionInstructions: string
  titleAbstractInstructions: string
  fullTextInstructions: string
  validationInstructions: string
}

function toDraft(flows: PromptFlow[]): Record<string, string> {
  return Object.fromEntries(flows.map((flow) => [flow.key, flow.customInstructions]))
}

export function PromptSettingsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['prompt-settings', projectId],
    queryFn: () => apiRequest<PromptSettingsResponse>(
      `/api/v1/projects/${projectId}/prompt-settings`,
    ),
    enabled: Boolean(projectId),
  })
  const [draft, setDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    if (settings.data) setDraft(toDraft(settings.data.flows))
  }, [settings.data])

  const save = useMutation({
    mutationFn: (payload: PromptSettingsUpdate) => apiRequest<PromptSettingsResponse>(
      `/api/v1/projects/${projectId}/prompt-settings`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
    onSuccess: (result) => {
      queryClient.setQueryData(['prompt-settings', projectId], result)
    },
  })

  const saveIfChanged = () => {
    if (!settings.data) return
    const current = toDraft(settings.data.flows)
    const changed = settings.data.flows.some((flow) => draft[flow.key] !== current[flow.key])
    if (!changed) return
    save.mutate({
      extractionInstructions: draft.extraction ?? '',
      titleAbstractInstructions: draft.titleAbstract ?? '',
      fullTextInstructions: draft.fullText ?? '',
      validationInstructions: draft.validation ?? '',
    })
  }

  return (
    <CollapsibleSection id="section-prompt-settings" title="AI Prompts" icon={<IconLightbulb />}>
      <InfoBox icon={<IconLightbulb />}>
        <p>
          Papertrail sends fixed base prompts to the LLM for each AI-assisted task, shown
          below for reference. Add project-specific instructions such as domain context,
          terminology, or emphasis to append to the base prompts.
        </p>
      </InfoBox>
      {settings.error ? <p className="text-danger" role="alert">{settings.error.message}</p> : null}
      {settings.data?.flows.map((flow) => (
        <div data-prompt-flow={flow.key} className="border-t border-border pt-4 first:border-t-0 first:pt-0 [&>*+*]:mt-4" key={flow.key}>
          <h3>{flow.label}</h3>
          <details>
            <summary>Base prompt</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg-elevated p-4 text-sm leading-[1.55] text-text-secondary">{flow.basePrompt}</pre>
          </details>
          <label className="grid gap-2 text-sm font-semibold text-text-secondary">
            Custom instructions
            <Textarea
              value={draft[flow.key] ?? ''}
              onChange={(event) => setDraft((current) => ({
                ...current, [flow.key]: event.target.value,
              }))}
              onBlur={saveIfChanged}
              rows={4}
              placeholder="Optional, e.g. domain-specific terminology or emphasis for this project"
            />
          </label>
        </div>
      ))}
      {save.error ? <p className="text-danger" role="alert">{save.error.message}</p> : null}
      <p className="text-text" aria-live="polite">
        {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ' '}
      </p>
    </CollapsibleSection>
  )
}

