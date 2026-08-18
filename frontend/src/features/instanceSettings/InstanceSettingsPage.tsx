import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { Button } from '../../components/Button'
import { InfoBox } from '../../components/InfoBox'
import { IconCheckCircle, IconLightbulb, IconSettings } from '../../components/icons'

interface InstallationConnectionSettings {
  enabled: boolean
  provider: string
  endpoint: string | null
  model: string | null
  contextLength: number
}

interface PromptFlow {
  key: string
  label: string
  defaultPrompt: string
  currentPrompt: string
  isOverridden: boolean
}

interface PromptOverridesResponse {
  flows: PromptFlow[]
}

const PROMPT_PAYLOAD_FIELD: Record<string, string> = {
  titleAbstract: 'titleAbstractPrompt',
  fullText: 'fullTextPrompt',
  extraction: 'extractionPrompt',
  validation: 'validationPrompt',
}

export function InstanceSettingsPage() {
  const queryClient = useQueryClient()
  const connection = useQuery({
    queryKey: ['instance-llm-connection'],
    queryFn: () => apiRequest<InstallationConnectionSettings>('/api/v1/llm/installation-settings'),
  })
  const prompts = useQuery({
    queryKey: ['instance-llm-prompts'],
    queryFn: () => apiRequest<PromptOverridesResponse>('/api/v1/llm/installation-settings/prompts'),
  })

  const [enabled, setEnabled] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [contextLength, setContextLength] = useState('32768')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [promptDraft, setPromptDraft] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!connection.data) return
    setEnabled(connection.data.enabled)
    setEndpoint(connection.data.endpoint ?? '')
    setModel(connection.data.model ?? '')
    setContextLength(String(connection.data.contextLength))
  }, [connection.data])

  useEffect(() => {
    if (!prompts.data) return
    setPromptDraft(Object.fromEntries(prompts.data.flows.map((flow) => [flow.key, flow.currentPrompt])))
  }, [prompts.data])

  const saveConnection = useMutation({
    mutationFn: () => apiRequest<InstallationConnectionSettings>('/api/v1/llm/installation-settings', {
      method: 'PATCH',
      body: JSON.stringify({ enabled, endpoint, model, contextLength: Number(contextLength) }),
    }),
    onSuccess: (result) => queryClient.setQueryData(['instance-llm-connection'], result),
  })

  const test = useMutation({
    mutationFn: () => apiRequest<{ available: boolean; modelAvailable: boolean; error?: string }>(
      '/api/v1/llm/installation-settings/test', { method: 'POST' },
    ),
    onSuccess: (result) => setTestResult({
      ok: result.available && result.modelAvailable,
      message: result.available
        ? result.modelAvailable ? 'Available; configured model found.' : 'Available; configured model not found.'
        : result.error ?? 'Unavailable',
    }),
    onError: (mutationError) => setTestResult({
      ok: false,
      message: mutationError instanceof Error ? mutationError.message : 'Unable to test the connection.',
    }),
  })

  const savePrompts = useMutation({
    mutationFn: (payload: Record<string, string | null>) => apiRequest<PromptOverridesResponse>(
      '/api/v1/llm/installation-settings/prompts',
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
    onSuccess: (result) => queryClient.setQueryData(['instance-llm-prompts'], result),
  })

  const savePromptsIfChanged = () => {
    if (!prompts.data) return
    const changes: Record<string, string | null> = {}
    for (const flow of prompts.data.flows) {
      const draftValue = (promptDraft[flow.key] ?? '').trim()
      if (draftValue !== flow.currentPrompt) {
        changes[PROMPT_PAYLOAD_FIELD[flow.key]] = draftValue
      }
    }
    if (Object.keys(changes).length === 0) return
    savePrompts.mutate(changes)
  }

  return (
    <main className="page">
      <p className="eyebrow">Installation administration</p>
      <h1>Instance Settings</h1>
      <p className="muted">
        Settings shared across every project on this Papertrail installation.
      </p>

      <CollapsibleSection id="section-instance-llm-connection" title="LLM Connection" icon={<IconSettings />}>
        <InfoBox icon={<IconSettings />}>
          <p>
            The Ollama connection Papertrail uses for LLM suggestions, shared across every project
            on this installation.
          </p>
        </InfoBox>
        {connection.data ? (
          <form
            className="llm-installation-settings"
            onSubmit={(event) => { event.preventDefault(); saveConnection.mutate() }}
          >
            <div className="llm-installation-settings__heading">
              <div>
                <h3>Connection configuration</h3>
              </div>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                />
                LLM enabled
              </label>
            </div>
            <div className="llm-installation-settings__grid">
              <label>
                Endpoint
                <input
                  type="url"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  placeholder="http://ollama:11434"
                  required
                />
              </label>
              <label>
                Model
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="gemma3:12b"
                  required
                />
              </label>
              <label>
                Context length
                <input
                  type="number"
                  min="4096"
                  step="1024"
                  value={contextLength}
                  onChange={(event) => setContextLength(event.target.value)}
                  required
                />
              </label>
            </div>
            <div className="toolbar">
              <Button type="submit" loading={saveConnection.isPending}>
                <IconCheckCircle />
                {saveConnection.isPending ? 'Saving…' : 'Save Connection Settings'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => test.mutate()}
                loading={test.isPending}
              >
                {test.isPending ? 'Testing…' : 'Test Connection'}
              </Button>
            </div>
          </form>
        ) : null}
        {testResult ? (
          <p className={testResult.ok ? 'success' : 'error'} role={testResult.ok ? 'status' : 'alert'}>
            {testResult.message}
          </p>
        ) : null}
        {saveConnection.error ? <p className="error" role="alert">{saveConnection.error.message}</p> : null}
      </CollapsibleSection>

      <CollapsibleSection id="section-instance-llm-prompts" title="AI Prompts" icon={<IconLightbulb />}>
        <InfoBox icon={<IconLightbulb />}>
          <p>
            The base system prompts Papertrail sends to the LLM for each task. Project owners can
            append project-specific instructions to these from their project&apos;s AI Prompts
            settings.
          </p>
        </InfoBox>
        {prompts.error ? <p className="error" role="alert">{prompts.error.message}</p> : null}
        {prompts.data?.flows.map((flow) => (
          <div className="prompt-flow" key={flow.key}>
            <h3>
              {flow.label}
              {flow.isOverridden ? <span className="status-badge">Customized</span> : null}
            </h3>
            <label>
              Base prompt
              <textarea
                value={promptDraft[flow.key] ?? ''}
                onChange={(event) => setPromptDraft((current) => ({
                  ...current, [flow.key]: event.target.value,
                }))}
                rows={8}
              />
            </label>
            <div className="toolbar">
              <Button
                type="button"
                variant="secondary"
                onClick={() => savePrompts.mutate({ [PROMPT_PAYLOAD_FIELD[flow.key]]: null })}
                disabled={!flow.isOverridden || savePrompts.isPending}
              >
                Reset to Default
              </Button>
            </div>
          </div>
        ))}
        <div className="toolbar">
          <Button type="button" onClick={savePromptsIfChanged} loading={savePrompts.isPending} disabled={!prompts.data}>
            <IconCheckCircle />
            {savePrompts.isPending ? 'Saving…' : 'Save Prompts'}
          </Button>
        </div>
        {savePrompts.error ? <p className="error" role="alert">{savePrompts.error.message}</p> : null}
      </CollapsibleSection>
    </main>
  )
}
