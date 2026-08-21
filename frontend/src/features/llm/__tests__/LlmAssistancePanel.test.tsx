import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LlmAssistancePanel } from '../LlmAssistancePanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const settings = {
  enabled: false,
  titleAbstractScreeningEnabled: false,
  fullTextScreeningEnabled: false,
  extractionValidationEnabled: false,
  installationEnabled: true,
  provider: 'Ollama',
  model: 'qwen3:8b',
  contextLength: 32768,
  currentSchemaVersionId: null,
}

describe('LlmAssistancePanel', () => {
  it('hides the endpoint from non-administrators and tests availability', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/llm/settings')) return jsonResponse(settings)
      if (path.endsWith('/llm/schema')) return jsonResponse({ schema: null, extractionFields: [] })
      if (path.includes('/llm/runs')) return jsonResponse({ total: 0, counts: {}, statistics: {}, overview: { eligible: 0, missingPdf: 0, outdatedSchema: 0 }, runs: [] })
      if (path.endsWith('/llm/test')) return jsonResponse({ available: true, modelAvailable: true })
      return jsonResponse({})
    })
    renderWithProviders(<LlmAssistancePanel projectId="p1" />)

    expect(await screen.findByText('qwen3:8b')).toBeInTheDocument()
    expect(screen.getByText('Context length').nextElementSibling).toHaveTextContent(/32.?768/)
    expect(screen.queryByText('http://ollama.example:11434')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Endpoint')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Context length')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save Installation Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Stages')).toHaveClass('subsection-heading')
    const schemaSection = screen.getByRole('heading', { name: 'LLM Extraction Schema' }).closest('section')
    expect(schemaSection).toContainElement(
      screen.getByRole('button', { name: 'Create LLM schema from extraction form' }),
    )
    expect(schemaSection).not.toContainElement(screen.getByRole('heading', { name: 'Processing Status' }))
    expect(screen.queryByText(/api key/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Enable LLM data extraction/i })).not.toBeInTheDocument()
    for (const name of [
      'Re-Run LLM Title/Abstract Screening',
      'Re-Run LLM Full-Text Screening',
      'Re-Run LLM Data Extraction',
      'Re-Run LLM Human Extraction Validation',
    ]) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeInTheDocument()
      // All capabilities are disabled in the default fixture settings, so
      // re-running any of them should not be possible.
      expect(button).toBeDisabled()
    }
    const rerunActions = screen.getByRole('button', {
      name: 'Re-Run LLM Title/Abstract Screening',
    }).parentElement
    expect(rerunActions).toHaveClass('llm-rerun-actions')
    expect(rerunActions?.children).toHaveLength(4)
    expect(rerunActions?.children[0]).toHaveStyle({ '--stage-color': '#1baf7a' })
    expect(rerunActions?.children[1]).toHaveStyle({ '--stage-color': '#eda100' })
    expect(rerunActions?.children[2]).toHaveStyle({ '--stage-color': '#e87ba4' })
    expect(rerunActions?.children[3]).toHaveStyle({ '--stage-color': '#e87ba4' })
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }))
    expect(await screen.findByText('Available; configured model found.')).toBeInTheDocument()
  })

  it('shows a warning banner when the installation-wide LLM support is disabled', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/llm/settings')) return jsonResponse({ ...settings, installationEnabled: false })
      if (path.endsWith('/llm/schema')) return jsonResponse({ schema: null, extractionFields: [] })
      if (path.includes('/llm/runs')) return jsonResponse({ total: 0, counts: {}, statistics: {}, overview: { eligible: 0, missingPdf: 0, outdatedSchema: 0 }, runs: [] })
      return jsonResponse({})
    })
    renderWithProviders(<LlmAssistancePanel projectId="p1" />)

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/LLM support is currently disabled for this Papertrail installation/)
    expect(banner).toHaveClass('info-box--danger')
  })

  it('re-runs an enabled capability with its task type', async () => {
    const fetchMock = mockFetch(async (input, ) => {
      const path = String(input)
      if (path.endsWith('/llm/settings')) {
        return jsonResponse({ ...settings, titleAbstractScreeningEnabled: true })
      }
      if (path.endsWith('/llm/schema')) return jsonResponse({ schema: null, extractionFields: [] })
      if (path.includes('/llm/runs') && path.endsWith('/reanalyze')) return jsonResponse({ taskType: 'title_abstract_screening', queued: 3, bulkId: 'bulk-1' })
      if (path.includes('/llm/runs')) return jsonResponse({ total: 0, counts: {}, statistics: {}, overview: { eligible: 0, missingPdf: 0, outdatedSchema: 0 }, runs: [] })
      return jsonResponse({})
    })
    renderWithProviders(<LlmAssistancePanel projectId="p1" />)

    const button = await screen.findByRole('button', { name: 'Re-Run LLM Title/Abstract Screening' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/reanalyze'))
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ taskType: 'title_abstract_screening' })
    })

    expect(screen.getByRole('button', { name: 'Re-Run LLM Full-Text Screening' })).toBeDisabled()
  })

  it('updates each optional capability independently', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/settings') && init?.method === 'PATCH') {
        return jsonResponse({ ...settings, ...JSON.parse(String(init.body)) })
      }
      if (path.endsWith('/llm/settings')) return jsonResponse(settings)
      if (path.endsWith('/llm/schema')) return jsonResponse({ schema: null, extractionFields: [] })
      if (path.includes('/llm/runs')) return jsonResponse({ total: 0, counts: {}, statistics: {}, overview: { eligible: 0, missingPdf: 0, outdatedSchema: 0 }, runs: [] })
      return jsonResponse({})
    })
    renderWithProviders(<LlmAssistancePanel projectId="p1" />)

    fireEvent.click(await screen.findByLabelText(/Title\/abstract screening suggestions/))
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ titleAbstractScreeningEnabled: true })
    })

    fireEvent.click(screen.getByLabelText('LLM data extraction'))
    await waitFor(() => {
      const patches = fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String(init?.body)))
      expect(patches).toContainEqual({ enabled: true })
    })
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
    const instruction = await screen.findByDisplayValue('Extract sample size.')
    expect(instruction).toBeInTheDocument()
    const field = instruction.closest('details') as HTMLDetailsElement
    expect(field).not.toHaveAttribute('open')
    fireEvent.click(field.querySelector('summary') as HTMLElement)
    expect(field).toHaveAttribute('open')

    const evidenceHelp = screen.getByRole('button', { name: 'About requiring evidence' })
    const evidenceTooltip = screen.getByText(/verifies the quote against the cited PDF page/)
    expect(evidenceTooltip).not.toBeVisible()
    fireEvent.focus(evidenceHelp)
    expect(evidenceTooltip).toBeVisible()
    fireEvent.blur(evidenceHelp)

    const inferredHelp = screen.getByRole('button', { name: 'About inferred values' })
    const inferredTooltip = screen.getByText(/Inferred results are rejected/)
    expect(inferredTooltip).not.toBeVisible()
    fireEvent.focus(inferredHelp)
    expect(inferredTooltip).toBeVisible()
    fireEvent.blur(inferredHelp)

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

  it('reorders LLM extraction fields with the shared drag handle', async () => {
    const schema = {
      id: 'schema-1', versionNumber: 1, status: 'draft',
      fields: [
        {
          stableKey: 'sample', label: 'Sample size', instruction: 'Extract sample size.',
          fieldType: 'number', mappedExtractionFieldKey: 'sample', options: [],
          evidenceRequired: true, allowInferred: false, enabled: true, position: 0,
        },
        {
          stableKey: 'design', label: 'Study design', instruction: 'Extract the study design.',
          fieldType: 'short_text', mappedExtractionFieldKey: 'design', options: [],
          evidenceRequired: true, allowInferred: false, enabled: true, position: 1,
        },
      ],
    }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/llm/settings')) return jsonResponse(settings)
      if (path.endsWith('/llm/schema') && !init?.method) return jsonResponse({
        schema,
        extractionFields: [
          { stableKey: 'sample', label: 'Sample size', fieldType: 'number', options: [] },
          { stableKey: 'design', label: 'Study design', fieldType: 'short_text', options: [] },
        ],
      })
      if (init?.method === 'PUT') return jsonResponse(schema)
      return jsonResponse({})
    })

    renderWithProviders(<LlmAssistancePanel projectId="p1" showProcessingStatus={false} />)

    const handle = await screen.findByRole('button', { name: 'Reorder Sample size' })
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      const savedFields = JSON.parse(String(saveCall?.[1]?.body)).fields
      expect(savedFields.map((field: { stableKey: string }) => field.stableKey)).toEqual(['design', 'sample'])
      expect(savedFields.map((field: { position: number }) => field.position)).toEqual([0, 1])
    })
  })
})
