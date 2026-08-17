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

describe('InstanceSettingsPage', () => {
  it('shows the connection settings and saves changes', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings') && init?.method === 'PATCH') {
        return jsonResponse({ ...connectionSettings, ...JSON.parse(String(init.body)) })
      }
      if (path.endsWith('/llm/installation-settings')) return jsonResponse(connectionSettings)
      if (path.endsWith('/llm/installation-settings/prompts')) return jsonResponse(promptSettings)
      return jsonResponse({})
    })
    renderWithProviders(<InstanceSettingsPage />)

    expect(await screen.findByDisplayValue('http://ollama.example:11434')).toBeInTheDocument()
    expect(screen.getByDisplayValue('qwen3:8b')).toBeInTheDocument()
    expect(screen.getByDisplayValue('32768')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gemma3:12b' } })
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
      })
    })
  })

  it('tests the connection', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings')) return jsonResponse(connectionSettings)
      if (path.endsWith('/llm/installation-settings/prompts')) return jsonResponse(promptSettings)
      if (path.endsWith('/llm/installation-settings/test')) {
        return jsonResponse({ available: true, modelAvailable: true })
      }
      return jsonResponse({})
    })
    renderWithProviders(<InstanceSettingsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Test Connection' }))
    expect(await screen.findByText('Available; configured model found.')).toBeInTheDocument()
  })

  it('shows each prompt flow with its overridden state and saves edits', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/installation-settings')) return jsonResponse(connectionSettings)
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
      if (path.endsWith('/llm/installation-settings/prompts')) return jsonResponse(promptSettings)
      return jsonResponse({})
    })
    renderWithProviders(<InstanceSettingsPage />)

    expect(await screen.findByText('Data extraction')).toBeInTheDocument()
    const extractionFlow = screen.getByText('Data extraction').closest('.prompt-flow') as HTMLElement
    expect(within(extractionFlow).getByText('Customized')).toBeInTheDocument()
    expect(within(extractionFlow).getByDisplayValue('Custom extraction instructions.')).toBeInTheDocument()
    expect(within(extractionFlow).getByRole('button', { name: 'Reset to Default' })).not.toBeDisabled()

    const validationFlow = screen.getByText('Extraction validation').closest('.prompt-flow') as HTMLElement
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
      if (path.endsWith('/llm/installation-settings')) return jsonResponse(connectionSettings)
      if (path.endsWith('/llm/installation-settings/prompts') && init?.method === 'PUT') {
        return jsonResponse({
          flows: promptSettings.flows.map((flow) => (
            flow.key === 'extraction'
              ? { ...flow, currentPrompt: flow.defaultPrompt, isOverridden: false }
              : flow
          )),
        })
      }
      if (path.endsWith('/llm/installation-settings/prompts')) return jsonResponse(promptSettings)
      return jsonResponse({})
    })
    renderWithProviders(<InstanceSettingsPage />)

    const extractionFlow = (await screen.findByText('Data extraction')).closest('.prompt-flow') as HTMLElement
    fireEvent.click(within(extractionFlow).getByRole('button', { name: 'Reset to Default' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/llm/installation-settings/prompts') && init?.method === 'PUT'
      ))
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ extractionPrompt: null })
    })
  })
})
