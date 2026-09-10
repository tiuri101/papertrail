import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { InstanceSettingsPage } from '../InstanceSettingsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const connectionSettings = {
  enabled: true,
  provider: 'Ollama',
  endpoint: 'http://ollama.example:11434',
  model: 'qwen3:8b',
  contextLength: 32768,
  apiKeySet: false,
  requestTimeoutSeconds: 300,
  maxConcurrentJobs: 1,
  maxEvidenceItems: 3,
  maxEvidenceQuoteChars: 500,
}

const promptSettings = {
  flows: [
    {
      key: 'titleAbstract',
      label: 'Title/abstract screening',
      defaultPrompt: 'You provide structured screening assistance.',
      currentPrompt: 'You provide structured screening assistance.',
      isOverridden: false,
    },
    {
      key: 'fullText',
      label: 'Full-text screening',
      defaultPrompt: 'You provide structured screening assistance.',
      currentPrompt: 'You provide structured screening assistance.',
      isOverridden: false,
    },
    {
      key: 'extraction',
      label: 'Data extraction',
      defaultPrompt: 'You extract structured information from an academic paper.',
      currentPrompt: 'Custom extraction instructions.',
      isOverridden: true,
    },
    {
      key: 'validation',
      label: 'Extraction validation',
      defaultPrompt: 'You validate human-entered extraction values.',
      currentPrompt: 'You validate human-entered extraction values.',
      isOverridden: false,
    },
  ],
}

const instanceSettings = {
  emailEnabled: true,
  publicBaseUrl: 'https://papertrail.example.org',
  smtpHost: 'smtp.example.org',
  smtpPort: 587,
  smtpUsername: 'notifications',
  smtpPasswordSet: true,
  smtpFromAddress: 'Papertrail <notifications@example.org>',
  smtpStarttls: true,
  smtpUseSsl: false,
  smtpTimeoutSeconds: 30,
  workerThreads: 4,
  jobPollIntervalSeconds: 1,
  jobLeaseSeconds: 300,
  browserRetrievalLeaseSeconds: 300,
  maxPdfSizeMb: 50,
  passwordResetTtlMinutes: 60,
  passwordResetMaxAttempts: 5,
}

function defaultRoutes(input: unknown, init?: RequestInit) {
  const path = String(input)
  if (path.endsWith('/llm/installation-settings/models')) {
    return jsonResponse({ available: true, models: ['gemma3:12b', 'qwen3:8b'] })
  }
  if (path.endsWith('/llm/installation-settings')) return jsonResponse(connectionSettings)
  if (path.endsWith('/llm/installation-settings/prompts')) return jsonResponse(promptSettings)
  if (path.endsWith('/instance-settings')) return jsonResponse(instanceSettings)
  void init
  return jsonResponse({})
}

describe('InstanceSettingsPage', () => {
  it('shows the connection settings and saves changes', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings') && init?.method === 'PATCH') {
        return jsonResponse({ ...connectionSettings, ...JSON.parse(String(init.body)), apiKeySet: false })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    expect(await screen.findByDisplayValue('http://ollama.example:11434')).toBeInTheDocument()
    const modelField = await screen.findByRole('combobox', { name: 'Model' })
    expect(modelField).toHaveValue('qwen3:8b')
    expect(screen.getByDisplayValue('32768')).toBeInTheDocument()

    fireEvent.change(modelField, { target: { value: 'gemma3:12b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Connection Settings' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/llm/installation-settings') && init?.method === 'PATCH'
      ))
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        enabled: true,
        endpoint: 'http://ollama.example:11434',
        model: 'gemma3:12b',
        contextLength: 32768,
        apiKey: null,
        requestTimeoutSeconds: 300,
        maxConcurrentJobs: 1,
        maxEvidenceItems: 3,
        maxEvidenceQuoteChars: 500,
      })
    })
  })

  it('tests the connection', async () => {
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings/test')) {
        return jsonResponse({ available: true, modelAvailable: true })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Test Connection' }))
    expect(await screen.findByText('Available; configured model found.')).toBeInTheDocument()
  })

  it('shows each prompt flow with its overridden state and saves edits', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings/prompts') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        return jsonResponse({
          flows: promptSettings.flows.map((flow) => (
            flow.key === 'validation' && 'validationPrompt' in body
              ? { ...flow, currentPrompt: body.validationPrompt, isOverridden: true }
              : flow
          )),
        })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    expect(await screen.findByText('Data extraction')).toBeInTheDocument()
    const extractionFlow = screen.getByText('Data extraction').closest('[data-prompt-flow]') as HTMLElement
    expect(within(extractionFlow).getByText('Customized')).toBeInTheDocument()
    expect(within(extractionFlow).getByDisplayValue('Custom extraction instructions.')).toBeInTheDocument()
    expect(within(extractionFlow).getByRole('button', { name: 'Reset to Default' })).not.toBeDisabled()

    const validationFlow = screen.getByText('Extraction validation').closest('[data-prompt-flow]') as HTMLElement
    expect(within(validationFlow).queryByText('Customized')).not.toBeInTheDocument()
    expect(within(validationFlow).getByRole('button', { name: 'Reset to Default' })).toBeDisabled()

    fireEvent.change(within(validationFlow).getByLabelText('Base prompt'), {
      target: { value: 'A brand-new validation base prompt.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Prompts' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/llm/installation-settings/prompts') && init?.method === 'PUT'
      ))
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        validationPrompt: 'A brand-new validation base prompt.',
      })
    })
  })

  it('resets an overridden prompt to its default', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings/prompts') && init?.method === 'PUT') {
        return jsonResponse({
          flows: promptSettings.flows.map((flow) => (
            flow.key === 'extraction'
              ? { ...flow, currentPrompt: flow.defaultPrompt, isOverridden: false }
              : flow
          )),
        })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    const extractionFlow = (await screen.findByText('Data extraction')).closest('[data-prompt-flow]') as HTMLElement
    fireEvent.click(within(extractionFlow).getByRole('button', { name: 'Reset to Default' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/llm/installation-settings/prompts') && init?.method === 'PUT'
      ))
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ extractionPrompt: null })
    })
  })

  it('shows the email settings and saves changes from the Email section', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/instance-settings') && init?.method === 'PATCH') {
        return jsonResponse({ ...instanceSettings, ...JSON.parse(String(init.body)), smtpPasswordSet: true })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    expect(await screen.findByDisplayValue('smtp.example.org')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('SMTP port'), { target: { value: '2525' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Email Settings' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/instance-settings') && init?.method === 'PATCH'
      ))
      const body = JSON.parse(String(call?.[1]?.body))
      expect(body.smtpPort).toBe(2525)
      expect(body.smtpPassword).toBeNull()
      expect(body.emailEnabled).toBe(true)
    })
  })

  it('sends a test email and reports the result', async () => {
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/instance-settings/test-email')) {
        return jsonResponse({ sent: true, error: null })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Send Test Email' }))
    expect(await screen.findByText('Test email sent to your account address.')).toBeInTheDocument()
  })

  it('reports a failed test email without crashing', async () => {
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/instance-settings/test-email')) {
        return jsonResponse({ sent: false, error: 'SMTP server unreachable' })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Send Test Email' }))
    expect(await screen.findByText('SMTP server unreachable')).toBeInTheDocument()
  })

  it('saves account security, PDF, and background job settings', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/instance-settings') && init?.method === 'PATCH') {
        return jsonResponse({ ...instanceSettings, ...JSON.parse(String(init.body)), smtpPasswordSet: true })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    fireEvent.change(await screen.findByLabelText('Password reset max attempts'), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Account Security Settings' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/instance-settings') && init?.method === 'PATCH'
      ))
      expect(JSON.parse(String(call?.[1]?.body)).passwordResetMaxAttempts).toBe(7)
    })

    fireEvent.change(screen.getByLabelText('Max PDF size (MB)'), { target: { value: '75' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save PDF Settings' }))
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([input, init]) => (
        String(input).endsWith('/instance-settings') && init?.method === 'PATCH'
      ))
      const call = patchCalls[patchCalls.length - 1]
      expect(JSON.parse(String(call?.[1]?.body)).maxPdfSizeMb).toBe(75)
    })

    fireEvent.change(screen.getByLabelText('Worker threads'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Background Job Settings' }))
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(([input, init]) => (
        String(input).endsWith('/instance-settings') && init?.method === 'PATCH'
      ))
      const call = patchCalls[patchCalls.length - 1]
      expect(JSON.parse(String(call?.[1]?.body)).workerThreads).toBe(6)
    })
  })

  it('offers the Ollama models as a dropdown and saves the picked one', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings') && init?.method === 'PATCH') {
        return jsonResponse({ ...connectionSettings, ...JSON.parse(String(init.body)), apiKeySet: false })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    const modelField = await screen.findByRole('combobox', { name: 'Model' })
    expect(within(modelField).getByRole('option', { name: 'gemma3:12b' })).toBeInTheDocument()
    expect(within(modelField).getByRole('option', { name: 'qwen3:8b' })).toBeInTheDocument()

    fireEvent.change(modelField, { target: { value: 'gemma3:12b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Connection Settings' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/llm/installation-settings') && init?.method === 'PATCH'
      ))
      expect(JSON.parse(String(call?.[1]?.body)).model).toBe('gemma3:12b')
    })
  })

  it('falls back to manual entry when Ollama models cannot be listed', async () => {
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings/models')) {
        return jsonResponse({ available: false, models: [], error: 'Ollama is unreachable' })
      }
      return defaultRoutes(input, init)
    })
    renderWithProviders(<InstanceSettingsPage />)

    expect(await screen.findByDisplayValue('http://ollama.example:11434')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText(/enter the name manually/i)).toBeInTheDocument()
    })
    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Model')).toHaveValue('qwen3:8b')
  })
})
