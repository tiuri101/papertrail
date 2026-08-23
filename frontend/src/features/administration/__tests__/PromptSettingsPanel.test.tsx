import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PromptSettingsPanel } from '../PromptSettingsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const promptSettings = {
  flows: [
    {
      key: 'extraction',
      label: 'Data extraction',
      basePrompt: 'You extract structured information from an academic paper.',
      customInstructions: '',
    },
    {
      key: 'titleAbstract',
      label: 'Title/abstract screening',
      basePrompt: 'You provide structured screening assistance.',
      customInstructions: 'Only robotics venues count.',
    },
    {
      key: 'fullText',
      label: 'Full-text screening',
      basePrompt: 'You provide structured screening assistance.',
      customInstructions: '',
    },
    {
      key: 'validation',
      label: 'Extraction validation',
      basePrompt: 'You validate human-entered extraction values.',
      customInstructions: '',
    },
  ],
}

describe('PromptSettingsPanel', () => {
  it('shows each flow with its base prompt and existing custom instructions', async () => {
    mockFetch(() => jsonResponse(promptSettings))
    renderWithProviders(<PromptSettingsPanel projectId="p1" />)

    expect(await screen.findByText('Data extraction')).toBeInTheDocument()
    expect(screen.getByText('Title/abstract screening')).toBeInTheDocument()

    const extractionField = screen.getByText('Data extraction').closest('[data-prompt-flow]')
    expect(extractionField).not.toBeNull()
    expect(within(extractionField as HTMLElement).getByText(
      'You extract structured information from an academic paper.',
    )).toBeInTheDocument()

    const titleAbstractField = screen.getByText('Title/abstract screening').closest('[data-prompt-flow]')
    expect(within(titleAbstractField as HTMLElement).getByDisplayValue(
      'Only robotics venues count.',
    )).toBeInTheDocument()
  })

  it('saves custom instructions for all flows when a field is edited', async () => {
    const fetchMock = mockFetch((_input, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        return jsonResponse({
          flows: promptSettings.flows.map((flow) => ({
            ...flow,
            customInstructions:
              flow.key === 'extraction'
                ? body.extractionInstructions
                : flow.customInstructions,
          })),
        })
      }
      return jsonResponse(promptSettings)
    })
    renderWithProviders(<PromptSettingsPanel projectId="p1" />)

    const extractionField = (await screen.findByText('Data extraction')).closest('[data-prompt-flow]') as HTMLElement
    const textarea = within(extractionField).getByLabelText('Custom instructions')
    fireEvent.change(textarea, { target: { value: "Treat 'RQ' as research question." } })
    fireEvent.blur(textarea)

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/prompt-settings')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        extractionInstructions: "Treat 'RQ' as research question.",
        titleAbstractInstructions: 'Only robotics venues count.',
        fullTextInstructions: '',
        validationInstructions: '',
      })
    })
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })
})
