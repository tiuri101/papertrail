import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ExtractionPage } from '../ExtractionPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const workItem = {
  id: 'extraction-1',
  publicationId: 'publication-1',
  fullTextAvailable: true,
  status: 'reserved',
  draft: {},
  publication: {
    title: 'Immersive Urban Analytics',
    authors: 'A. Author',
    publicationYear: 2024,
    doi: '10.1000/example',
    publisherUrl: null,
  },
  fields: [
    { id: 'field-1', stableKey: 'finding', label: 'Main finding', fieldType: 'long_text', required: true, options: [] },
    { id: 'field-2', stableKey: 'sampleSize', label: 'Sample size', fieldType: 'number', required: false, options: [] },
  ],
}

describe('ExtractionPage', () => {
  it('fetches the next extraction automatically on load and renders publication context', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByText(/A\. Author/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View PDF' })).toHaveAttribute(
      'href',
      '/api/v1/projects/p1/publications/publication-1/full-text/content',
    )
    expect(screen.getByRole('link', { name: 'Open DOI' })).toHaveAttribute('href', 'https://doi.org/10.1000/example')
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')).toHaveLength(1)
  })

  it('temporarily skips an extraction and requests another item', async () => {
    const second = {
      ...workItem,
      id: 'extraction-2',
      publicationId: 'publication-2',
      publication: { ...workItem.publication, title: 'Second extraction' },
    }
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input)
      if (url.includes('/extraction/next') && init?.method === 'POST') {
        return jsonResponse(url.includes('excludedItemId=extraction-1') ? second : workItem)
      }
      if (url.endsWith('/extraction/extraction-1/release') && init?.method === 'POST') {
        return jsonResponse({ status: 'released' })
      }
      return jsonResponse({ state: 'disabled' })
    })
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))

    expect(await screen.findByRole('heading', { name: 'Second extraction' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('excludedItemId=extraction-1'))).toBe(true)
  })

  it('shows how many assigned papers have been extracted', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/extraction/progress')) return jsonResponse({ assigned: 5, completed: 2 })
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByText('2 of 5 assigned papers extracted')).toBeInTheDocument()
  })

  it('renders a dynamic form field per active field and pre-fills the draft', async () => {
    mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ ...workItem, draft: { finding: 'Draft note' } })
      : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByLabelText('Main finding *')).toHaveValue('Draft note')
    expect(screen.getByLabelText('Sample size')).toBeInTheDocument()
  })

  it('disables submit until every required field is answered', async () => {
    mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    expect(screen.getByRole('button', { name: 'Submit Extraction' })).toBeDisabled()
    expect(screen.getByText('Answer every required field before submitting.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Main finding *'), { target: { value: 'Uses VR for analytics' } })
    expect(screen.getByRole('button', { name: 'Submit Extraction' })).toBeEnabled()
  })

  it('submits human answers and immediately advances without per-paper validation', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      if (path.endsWith('/extraction/extraction-1') && init?.method === 'POST') return jsonResponse({ id: 'response-1', answers: {}, version: 1, formVersionId: 'v1' }, 201)
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.change(screen.getByLabelText('Main finding *'), { target: { value: 'Uses VR for analytics' } })
    fireEvent.change(screen.getByLabelText('Sample size'), { target: { value: '24' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Extraction' }))

    await waitFor(() => {
      const submitCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/extraction/extraction-1'))
      expect(submitCall).toBeTruthy()
      expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({
        answers: { finding: 'Uses VR for analytics', sampleSize: 24 },
        suggestionActions: { finding: 'manual', sampleSize: 'manual' },
      })
    })
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/llm-validation'))).toBe(false)
    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
    expect(screen.queryByText('Extraction saved')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue to next paper' })).not.toBeInTheDocument()
  })

  it('reports that the reviewer has completed all assigned extraction work, with a way back to the project', async () => {
    mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(null) : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByText('You have completed all of your assigned extraction work.')).toBeInTheDocument()
    expect(screen.queryByText('Loading the next extraction…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to project' })).toBeInTheDocument()
  })

  it('reports a load error', async () => {
    mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ error: { message: 'Something went wrong' } }, 500)
      : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
  })

  it('autosaves draft answers shortly after editing', async () => {
    const fetchMock = mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.change(screen.getByLabelText('Main finding *'), { target: { value: 'Draft in progress' } })

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/extraction-1/draft'))).toBe(false)

    await waitFor(() => {
      const draftCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/extraction-1/draft'))
      expect(draftCall).toBeTruthy()
      expect(JSON.parse(String(draftCall?.[1]?.body))).toEqual({ draft: { finding: 'Draft in progress' } })
    }, { timeout: 2000 })
  })

  it('does not offer PDF viewing when no stored full text is available', async () => {
    mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ ...workItem, fullTextAvailable: false })
      : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    expect(screen.queryByRole('link', { name: 'View PDF' })).not.toBeInTheDocument()
  })

  it('shows mapped suggestions, inference status, and verified evidence in context', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/llm-suggestions')) return jsonResponse({
        state: 'ready', runId: 'run-1', documentId: 'doc-1', schemaVersion: 1,
        model: 'test-model', outdated: false, error: null,
        suggestions: [{
          id: 'suggestion-1', mappedExtractionFieldKey: 'sampleSize', label: 'Sample size',
          value: 24, status: 'inferred', evidenceRequired: true,
          evidenceValidationStatus: 'verified', helper: false,
          evidence: [{ page: 8, quote: 'Twenty-four participants took part.', verified: true }],
        }],
      })
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByText(/LLM suggestion · inferred/i)).toBeInTheDocument()
    expect(screen.getByText(/paper does not state it directly/i)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Evidence (1)'))
    expect(screen.getByText(/Verified evidence/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open PDF at page 8' })).toHaveAttribute('href', expect.stringContaining('#page=8'))
  })

  it('never overwrites an existing reviewer draft and applies a suggestion only on request', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse({ ...workItem, draft: { sampleSize: 22 } })
      if (path.endsWith('/llm-suggestions')) return jsonResponse({
        state: 'ready', runId: 'run-1', documentId: 'doc-1', schemaVersion: 1,
        model: 'test-model', outdated: false, error: null,
        suggestions: [{
          id: 'suggestion-1', mappedExtractionFieldKey: 'sampleSize', label: 'Sample size',
          value: 24, status: 'explicit', evidenceRequired: false,
          evidenceValidationStatus: 'not_required', helper: false, evidence: [],
        }],
      })
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByLabelText('Sample size')).toHaveValue(22)
    fireEvent.click(await screen.findByRole('button', { name: 'Reset to LLM suggestion' }))
    expect(screen.getByLabelText('Sample size')).toHaveValue(24)
    expect(screen.getByText('Reviewer value matches suggestion')).toBeInTheDocument()
  })

  it('records accepted suggestion provenance with the submitted human value', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/llm-suggestions')) return jsonResponse({
        state: 'ready', runId: 'run-1', documentId: 'doc-1', schemaVersion: 1,
        model: 'test-model', outdated: false, error: null,
        suggestions: [{
          id: 'suggestion-1', mappedExtractionFieldKey: 'sampleSize', label: 'Sample size',
          value: 24, status: 'explicit', evidenceRequired: false,
          evidenceValidationStatus: 'not_required', helper: false, evidence: [],
        }],
      })
      if (path.endsWith('/extraction/extraction-1') && init?.method === 'POST') {
        return jsonResponse({ id: 'response-1', answers: {}, version: 1, formVersionId: 'v1' }, 201)
      }
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    fireEvent.change(await screen.findByLabelText('Main finding *'), { target: { value: 'Human finding' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Apply suggestion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit Extraction' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/extraction/extraction-1') && init?.method === 'POST'
      ))
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        answers: { finding: 'Human finding', sampleSize: 24 },
        suggestionActions: { finding: 'manual', sampleSize: 'accepted' },
      })
    })
  })

  it('shows extraction validation without changing the human values', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/extraction/extraction-1')) {
        return jsonResponse({
          ...workItem,
          status: 'completed',
          draft: { finding: 'Human finding' },
          currentResponse: {
            id: 'response-1', answers: { finding: 'Human finding' },
            version: 1, formVersionId: 'v1',
          },
        })
      }
      if (path.endsWith('/llm-validation')) return jsonResponse({
        state: 'ready', runId: 'validation-1', responseId: 'response-1',
        model: 'test-model', promptVersion: 'extraction_validation_v1',
        stale: false, error: null,
        results: [{
          fieldKey: 'finding', fieldLabel: 'Main finding', value: 'Human finding',
          assessment: 'contradicted', explanation: 'The paper states a different result.',
          evidenceValidationStatus: 'verified',
          evidence: [{ page: 8, section: 'Results', quote: 'A different result.', verified: true }],
        }],
      })
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, {
      route: '/projects/p1/extraction/review/extraction-1',
      path: '/projects/:projectId/extraction/review/:itemId',
    })

    expect(await screen.findByText(/1 contradicted/)).toBeInTheDocument()
    expect(screen.getByText(/Validation: contradicted/)).toBeInTheDocument()
    expect(screen.getByLabelText('Main finding *')).toHaveValue('Human finding')
    expect(screen.getByRole('link', { name: 'Open PDF at page 8' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to validation review' })).toHaveAttribute(
      'href',
      '/projects/p1/extraction/validation',
    )
  })

  it('shows no LLM placeholder when data extraction assistance is disabled', async () => {
    mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse(workItem)
      : jsonResponse({ state: 'disabled' }))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    await waitFor(() => {
      expect(screen.queryByText('Checking for LLM suggestions…')).not.toBeInTheDocument()
    })
    expect(screen.queryByText(/LLM assistance/)).not.toBeInTheDocument()
  })

  it('shows no LLM validation placeholder when validation is disabled', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/extraction/extraction-1')) {
        return jsonResponse({
          ...workItem,
          status: 'completed',
          draft: { finding: 'Human finding' },
          currentResponse: {
            id: 'response-1', answers: { finding: 'Human finding' },
            version: 1, formVersionId: 'v1',
          },
        })
      }
      if (path.endsWith('/llm-validation')) return jsonResponse({ state: 'disabled', responseId: 'response-1' })
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, {
      route: '/projects/p1/extraction/review/extraction-1',
      path: '/projects/:projectId/extraction/review/:itemId',
    })

    expect(await screen.findByLabelText('Main finding *')).toHaveValue('Human finding')
    await waitFor(() => {
      expect(screen.queryByText('LLM extraction validation')).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('link', { name: 'Back to validation review' })).not.toBeInTheDocument()
  })

  it('keeps manual extraction usable when LLM processing fails', async () => {
    mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse(workItem)
      : jsonResponse({
        state: 'failed', runId: 'run-1', documentId: 'doc-1', schemaVersion: 1,
        model: 'test-model', outdated: false, error: 'Ollama unavailable', suggestions: [],
      }))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByText(/Ollama unavailable/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Main finding *'), { target: { value: 'Manual answer' } })
    expect(screen.getByRole('button', { name: 'Submit Extraction' })).toBeEnabled()
  })
})
