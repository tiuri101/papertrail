import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import { IconLightbulb } from '../../components/icons'

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
      {settings.error ? <p className="error" role="alert">{settings.error.message}</p> : null}
      {settings.data?.flows.map((flow) => (
        <div className="prompt-flow" key={flow.key}>
          <h3>{flow.label}</h3>
          <details>
            <summary>Base prompt</summary>
            <pre className="prompt-flow__base">{flow.basePrompt}</pre>
          </details>
          <label>
            Custom instructions
            <textarea
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
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <p className="muted" aria-live="polite">
        {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ' '}
      </p>
    </CollapsibleSection>
  )
}

