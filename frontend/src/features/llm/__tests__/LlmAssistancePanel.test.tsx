import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LlmAssistancePanel } from '../LlmAssistancePanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const settings = {
  enabled: false,
  installationEnabled: true,
  provider: 'Ollama',
  endpoint: 'http://ollama.example:11434',
  model: 'qwen3:8b',
  contextLength: 32768,
  currentSchemaVersionId: null,
}

describe('LlmAssistancePanel', () => {
  it('shows backend-only connection configuration and tests availability', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/llm/settings')) return jsonResponse(settings)
      if (path.endsWith('/llm/schema')) return jsonResponse({ schema: null, extractionFields: [] })
      if (path.includes('/llm/runs')) return jsonResponse({ total: 0, counts: {}, statistics: {}, overview: { eligible: 0, missingPdf: 0, outdatedSchema: 0 }, runs: [] })
      if (path.endsWith('/llm/test')) return jsonResponse({ available: true, modelAvailable: true })
      return jsonResponse({})
    })
    renderWithProviders(<LlmAssistancePanel projectId="p1" />)

    expect(await screen.findByText('http://ollama.example:11434')).toBeInTheDocument()
    expect(screen.queryByText(/api key/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))
    expect(await screen.findByText('Available; configured model found.')).toBeInTheDocument()
  })

  it('initializes, edits, maps, and publishes a schema', async () => {
    let schema: Record<string, unknown> | null = null
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/settings')) return jsonResponse(settings)
      if (path.includes('/llm/runs')) return jsonResponse({ total: 0, counts: {}, statistics: {}, overview: { eligible: 0, missingPdf: 0, outdatedSchema: 0 }, runs: [] })
      if (path.endsWith('/llm/schema') && !init?.method) return jsonResponse({
        schema,
        extractionFields: [{ stableKey: 'sample', label: 'Sample size', fieldType: 'number', options: [] }],
      })
      if (path.endsWith('/from-extraction-form')) {
        schema = {
          id: 'schema-1', versionNumber: 1, status: 'draft',
          fields: [{
            stableKey: 'sample', label: 'Sample size', instruction: 'Extract sample size.',
            fieldType: 'number', mappedExtractionFieldKey: 'sample', options: [],
            evidenceRequired: true, allowInferred: false, enabled: true,
            position: 0, mappingState: 'active',
          }],
        }
        return jsonResponse(schema)
      }
      if (path.endsWith('/publish')) return jsonResponse({ ...schema, status: 'published' })
      if (init?.method === 'PUT') return jsonResponse(schema)
      return jsonResponse({})
    })
    renderWithProviders(<LlmAssistancePanel projectId="p1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Create LLM schema from extraction form' }))
    expect(await screen.findByDisplayValue('Extract sample size.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Extraction instruction'), {
      target: { value: 'Return the main evaluation sample only.' },
    })
    fireEvent.click(screen.getByLabelText('Allow inferred values'))
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(call).toBeTruthy()
      expect(String(call?.[1]?.body)).toContain('Return the main evaluation sample only.')
    })
    fireEvent.click(screen.getByRole('button', { name: 'Publish version' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/publish'))).toBe(true))
  })
})
