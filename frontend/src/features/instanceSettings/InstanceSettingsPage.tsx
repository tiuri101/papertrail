import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { Button } from '../../components/Button'
import { InfoBox } from '../../components/InfoBox'
import {
  IconAlertTriangle,
  IconCheckCircle,
  IconClock,
  IconFile,
  IconLightbulb,
  IconMail,
  IconSettings,
} from '../../components/icons'

interface InstallationConnectionSettings {
  enabled: boolean
  provider: string
  endpoint: string | null
  model: string | null
  contextLength: number
  apiKeySet: boolean
  requestTimeoutSeconds: number
  maxConcurrentJobs: number
  maxEvidenceItems: number
  maxEvidenceQuoteChars: number
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

interface InstanceSettingsData {
  emailEnabled: boolean
  publicBaseUrl: string
  smtpHost: string | null
  smtpPort: number
  smtpUsername: string | null
  smtpPasswordSet: boolean
  smtpFromAddress: string | null
  smtpStarttls: boolean
  smtpUseSsl: boolean
  smtpTimeoutSeconds: number
  workerThreads: number
  jobPollIntervalSeconds: number
  jobLeaseSeconds: number
  browserRetrievalLeaseSeconds: number
  maxPdfSizeMb: number
  passwordResetTtlMinutes: number
  passwordResetMaxAttempts: number
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
  const instance = useQuery({
    queryKey: ['instance-settings'],
    queryFn: () => apiRequest<InstanceSettingsData>('/api/v1/instance-settings'),
  })

  const [enabled, setEnabled] = useState(false)
  const [endpoint, setEndpoint] = useState('')
  const [model, setModel] = useState('')
  const [contextLength, setContextLength] = useState('32768')
  const [apiKey, setApiKey] = useState('')
  const [apiKeySet, setApiKeySet] = useState(false)
  const [requestTimeoutSeconds, setRequestTimeoutSeconds] = useState('300')
  const [maxConcurrentJobs, setMaxConcurrentJobs] = useState('1')
  const [maxEvidenceItems, setMaxEvidenceItems] = useState('3')
  const [maxEvidenceQuoteChars, setMaxEvidenceQuoteChars] = useState('500')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [promptDraft, setPromptDraft] = useState<Record<string, string>>({})

  const [emailEnabled, setEmailEnabled] = useState(false)
  const [publicBaseUrl, setPublicBaseUrl] = useState('')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('587')
  const [smtpUsername, setSmtpUsername] = useState('')
  const [smtpPassword, setSmtpPassword] = useState('')
  const [smtpPasswordSet, setSmtpPasswordSet] = useState(false)
  const [smtpFromAddress, setSmtpFromAddress] = useState('')
  const [smtpStarttls, setSmtpStarttls] = useState(true)
  const [smtpUseSsl, setSmtpUseSsl] = useState(false)
  const [smtpTimeoutSeconds, setSmtpTimeoutSeconds] = useState('30')
  const [workerThreads, setWorkerThreads] = useState('4')
  const [jobPollIntervalSeconds, setJobPollIntervalSeconds] = useState('1')
  const [jobLeaseSeconds, setJobLeaseSeconds] = useState('300')
  const [browserRetrievalLeaseSeconds, setBrowserRetrievalLeaseSeconds] = useState('300')
  const [maxPdfSizeMb, setMaxPdfSizeMb] = useState('50')
  const [passwordResetTtlMinutes, setPasswordResetTtlMinutes] = useState('60')
  const [passwordResetMaxAttempts, setPasswordResetMaxAttempts] = useState('5')
  const [testEmailResult, setTestEmailResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (!connection.data) return
    setEnabled(connection.data.enabled)
    setEndpoint(connection.data.endpoint ?? '')
    setModel(connection.data.model ?? '')
    setContextLength(String(connection.data.contextLength))
    setApiKeySet(connection.data.apiKeySet)
    setRequestTimeoutSeconds(String(connection.data.requestTimeoutSeconds))
    setMaxConcurrentJobs(String(connection.data.maxConcurrentJobs))
    setMaxEvidenceItems(String(connection.data.maxEvidenceItems))
    setMaxEvidenceQuoteChars(String(connection.data.maxEvidenceQuoteChars))
  }, [connection.data])

  useEffect(() => {
    if (!prompts.data) return
    setPromptDraft(Object.fromEntries(prompts.data.flows.map((flow) => [flow.key, flow.currentPrompt])))
  }, [prompts.data])

  useEffect(() => {
    if (!instance.data) return
    setEmailEnabled(instance.data.emailEnabled)
    setPublicBaseUrl(instance.data.publicBaseUrl)
    setSmtpHost(instance.data.smtpHost ?? '')
    setSmtpPort(String(instance.data.smtpPort))
    setSmtpUsername(instance.data.smtpUsername ?? '')
    setSmtpPasswordSet(instance.data.smtpPasswordSet)
    setSmtpFromAddress(instance.data.smtpFromAddress ?? '')
    setSmtpStarttls(instance.data.smtpStarttls)
    setSmtpUseSsl(instance.data.smtpUseSsl)
    setSmtpTimeoutSeconds(String(instance.data.smtpTimeoutSeconds))
    setWorkerThreads(String(instance.data.workerThreads))
    setJobPollIntervalSeconds(String(instance.data.jobPollIntervalSeconds))
    setJobLeaseSeconds(String(instance.data.jobLeaseSeconds))
    setBrowserRetrievalLeaseSeconds(String(instance.data.browserRetrievalLeaseSeconds))
    setMaxPdfSizeMb(String(instance.data.maxPdfSizeMb))
    setPasswordResetTtlMinutes(String(instance.data.passwordResetTtlMinutes))
    setPasswordResetMaxAttempts(String(instance.data.passwordResetMaxAttempts))
  }, [instance.data])

  const saveConnection = useMutation({
    mutationFn: () => apiRequest<InstallationConnectionSettings>('/api/v1/llm/installation-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        enabled,
        endpoint,
        model,
        contextLength: Number(contextLength),
        apiKey: apiKey.trim() ? apiKey : null,
        requestTimeoutSeconds: Number(requestTimeoutSeconds),
        maxConcurrentJobs: Number(maxConcurrentJobs),
        maxEvidenceItems: Number(maxEvidenceItems),
        maxEvidenceQuoteChars: Number(maxEvidenceQuoteChars),
      }),
    }),
    onSuccess: (result) => {
      queryClient.setQueryData(['instance-llm-connection'], result)
      setApiKey('')
    },
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

  const saveInstanceSettings = useMutation({
    mutationFn: () => apiRequest<InstanceSettingsData>('/api/v1/instance-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        emailEnabled,
        publicBaseUrl,
        smtpHost: smtpHost.trim() || null,
        smtpPort: Number(smtpPort),
        smtpUsername: smtpUsername.trim() || null,
        smtpPassword: smtpPassword.trim() ? smtpPassword : null,
        smtpFromAddress: smtpFromAddress.trim() || null,
        smtpStarttls,
        smtpUseSsl,
        smtpTimeoutSeconds: Number(smtpTimeoutSeconds),
        workerThreads: Number(workerThreads),
        jobPollIntervalSeconds: Number(jobPollIntervalSeconds),
        jobLeaseSeconds: Number(jobLeaseSeconds),
        browserRetrievalLeaseSeconds: Number(browserRetrievalLeaseSeconds),
        maxPdfSizeMb: Number(maxPdfSizeMb),
        passwordResetTtlMinutes: Number(passwordResetTtlMinutes),
        passwordResetMaxAttempts: Number(passwordResetMaxAttempts),
      }),
    }),
    onSuccess: (result) => {
      queryClient.setQueryData(['instance-settings'], result)
      setSmtpPassword('')
    },
  })

  const testEmail = useMutation({
    mutationFn: () => apiRequest<{ sent: boolean; error?: string | null }>(
      '/api/v1/instance-settings/test-email', { method: 'POST' },
    ),
    onSuccess: (result) => setTestEmailResult({
      ok: result.sent,
      message: result.sent ? 'Test email sent to your account address.' : result.error ?? 'Unable to send a test email.',
    }),
    onError: (mutationError) => setTestEmailResult({
      ok: false,
      message: mutationError instanceof Error ? mutationError.message : 'Unable to send a test email.',
    }),
  })

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
              <label>
                API key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={apiKeySet ? 'Saved — leave blank to keep it' : 'Optional bearer token'}
                  autoComplete="new-password"
                />
              </label>
              <label>
                Request timeout (seconds)
                <input
                  type="number"
                  min="1"
                  value={requestTimeoutSeconds}
                  onChange={(event) => setRequestTimeoutSeconds(event.target.value)}
                  required
                />
              </label>
              <label>
                Max concurrent jobs
                <input
                  type="number"
                  min="1"
                  value={maxConcurrentJobs}
                  onChange={(event) => setMaxConcurrentJobs(event.target.value)}
                  required
                />
              </label>
              <label>
                Max evidence items
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={maxEvidenceItems}
                  onChange={(event) => setMaxEvidenceItems(event.target.value)}
                  required
                />
              </label>
              <label>
                Max evidence quote length (characters)
                <input
                  type="number"
                  min="50"
                  max="2000"
                  value={maxEvidenceQuoteChars}
                  onChange={(event) => setMaxEvidenceQuoteChars(event.target.value)}
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

      <CollapsibleSection id="section-instance-email" title="Email (SMTP)" icon={<IconMail />}>
        <InfoBox icon={<IconMail />}>
          <p>
            The SMTP connection Papertrail's background worker uses to deliver account, project, and
            password-reset emails.
          </p>
        </InfoBox>
        {instance.data ? (
          <form
            className="llm-installation-settings"
            onSubmit={(event) => { event.preventDefault(); saveInstanceSettings.mutate() }}
          >
            <div className="llm-installation-settings__heading">
              <div>
                <h3>SMTP configuration</h3>
              </div>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={emailEnabled}
                  onChange={(event) => setEmailEnabled(event.target.checked)}
                />
                Email enabled
              </label>
            </div>
            <div className="llm-installation-settings__grid">
              <label>
                Public base URL
                <input
                  type="url"
                  value={publicBaseUrl}
                  onChange={(event) => setPublicBaseUrl(event.target.value)}
                  placeholder="https://papertrail.example.org"
                  required
                />
              </label>
              <label>
                SMTP host
                <input
                  value={smtpHost}
                  onChange={(event) => setSmtpHost(event.target.value)}
                  placeholder="smtp.example.org"
                />
              </label>
              <label>
                SMTP port
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={smtpPort}
                  onChange={(event) => setSmtpPort(event.target.value)}
                  required
                />
              </label>
              <label>
                SMTP username
                <input
                  value={smtpUsername}
                  onChange={(event) => setSmtpUsername(event.target.value)}
                />
              </label>
              <label>
                SMTP password
                <input
                  type="password"
                  value={smtpPassword}
                  onChange={(event) => setSmtpPassword(event.target.value)}
                  placeholder={smtpPasswordSet ? 'Saved — leave blank to keep it' : ''}
                  autoComplete="new-password"
                />
              </label>
              <label>
                From address
                <input
                  value={smtpFromAddress}
                  onChange={(event) => setSmtpFromAddress(event.target.value)}
                  placeholder="Papertrail <noreply@example.org>"
                />
              </label>
              <label>
                SMTP timeout (seconds)
                <input
                  type="number"
                  min="1"
                  value={smtpTimeoutSeconds}
                  onChange={(event) => setSmtpTimeoutSeconds(event.target.value)}
                  required
                />
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={smtpStarttls}
                  onChange={(event) => setSmtpStarttls(event.target.checked)}
                />
                Use STARTTLS
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={smtpUseSsl}
                  onChange={(event) => setSmtpUseSsl(event.target.checked)}
                />
                Use implicit SSL
              </label>
            </div>
            <div className="toolbar">
              <Button type="submit" loading={saveInstanceSettings.isPending}>
                <IconCheckCircle />
                {saveInstanceSettings.isPending ? 'Saving…' : 'Save Email Settings'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => testEmail.mutate()}
                loading={testEmail.isPending}
              >
                {testEmail.isPending ? 'Sending…' : 'Send Test Email'}
              </Button>
            </div>
          </form>
        ) : null}
        {testEmailResult ? (
          <p className={testEmailResult.ok ? 'success' : 'error'} role={testEmailResult.ok ? 'status' : 'alert'}>
            {testEmailResult.message}
          </p>
        ) : null}
        {saveInstanceSettings.error ? (
          <p className="error" role="alert">{saveInstanceSettings.error.message}</p>
        ) : null}
      </CollapsibleSection>

      <CollapsibleSection id="section-instance-account-security" title="Account Security" icon={<IconClock />}>
        <InfoBox icon={<IconClock />}>
          <p>Password reset link lifetime and how many reset attempts an account may make before being throttled.</p>
        </InfoBox>
        {instance.data ? (
          <form
            className="llm-installation-settings"
            onSubmit={(event) => { event.preventDefault(); saveInstanceSettings.mutate() }}
          >
            <div className="llm-installation-settings__grid">
              <label>
                Password reset link lifetime (minutes)
                <input
                  type="number"
                  min="1"
                  value={passwordResetTtlMinutes}
                  onChange={(event) => setPasswordResetTtlMinutes(event.target.value)}
                  required
                />
              </label>
              <label>
                Password reset max attempts
                <input
                  type="number"
                  min="1"
                  value={passwordResetMaxAttempts}
                  onChange={(event) => setPasswordResetMaxAttempts(event.target.value)}
                  required
                />
              </label>
            </div>
            <div className="toolbar">
              <Button type="submit" loading={saveInstanceSettings.isPending}>
                <IconCheckCircle />
                {saveInstanceSettings.isPending ? 'Saving…' : 'Save Account Security Settings'}
              </Button>
            </div>
          </form>
        ) : null}
      </CollapsibleSection>

      <CollapsibleSection id="section-instance-pdfs" title="Full-Text PDFs" icon={<IconFile />}>
        <InfoBox icon={<IconFile />}>
          <p>
            The maximum size accepted for an uploaded or browser-retrieved PDF, and how long the
            browser extension may hold a claimed retrieval job before it is reclaimable.
          </p>
        </InfoBox>
        {instance.data ? (
          <form
            className="llm-installation-settings"
            onSubmit={(event) => { event.preventDefault(); saveInstanceSettings.mutate() }}
          >
            <div className="llm-installation-settings__grid">
              <label>
                Max PDF size (MB)
                <input
                  type="number"
                  min="1"
                  value={maxPdfSizeMb}
                  onChange={(event) => setMaxPdfSizeMb(event.target.value)}
                  required
                />
              </label>
              <label>
                Browser retrieval lease (seconds)
                <input
                  type="number"
                  min="1"
                  value={browserRetrievalLeaseSeconds}
                  onChange={(event) => setBrowserRetrievalLeaseSeconds(event.target.value)}
                  required
                />
              </label>
            </div>
            <div className="toolbar">
              <Button type="submit" loading={saveInstanceSettings.isPending}>
                <IconCheckCircle />
                {saveInstanceSettings.isPending ? 'Saving…' : 'Save PDF Settings'}
              </Button>
            </div>
          </form>
        ) : null}
      </CollapsibleSection>

      <CollapsibleSection id="section-instance-background-jobs" title="Background Jobs" icon={<IconAlertTriangle />}>
        <InfoBox icon={<IconAlertTriangle />}>
          <p>
            Worker thread count and poll interval only take effect the next time the background
            worker process restarts. Job lease applies immediately to newly claimed jobs.
          </p>
        </InfoBox>
        {instance.data ? (
          <form
            className="llm-installation-settings"
            onSubmit={(event) => { event.preventDefault(); saveInstanceSettings.mutate() }}
          >
            <div className="llm-installation-settings__grid">
              <label>
                Worker threads
                <input
                  type="number"
                  min="1"
                  value={workerThreads}
                  onChange={(event) => setWorkerThreads(event.target.value)}
                  required
                />
              </label>
              <label>
                Poll interval (seconds)
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={jobPollIntervalSeconds}
                  onChange={(event) => setJobPollIntervalSeconds(event.target.value)}
                  required
                />
              </label>
              <label>
                Job lease (seconds)
                <input
                  type="number"
                  min="1"
                  value={jobLeaseSeconds}
                  onChange={(event) => setJobLeaseSeconds(event.target.value)}
                  required
                />
              </label>
            </div>
            <div className="toolbar">
              <Button type="submit" loading={saveInstanceSettings.isPending}>
                <IconCheckCircle />
                {saveInstanceSettings.isPending ? 'Saving…' : 'Save Background Job Settings'}
              </Button>
            </div>
          </form>
        ) : null}
      </CollapsibleSection>
    </main>
  )
}
