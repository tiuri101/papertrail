import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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

  it('submits the answers and automatically fetches the next extraction', async () => {
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
      })
    })
    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
  })

  it('reports that no extraction work is currently available', async () => {
    mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(null) : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByText('No extraction work is currently available.')).toBeInTheDocument()
    expect(screen.queryByText('Loading the next extraction…')).not.toBeInTheDocument()
  })

  it('reports a load error', async () => {
    mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ error: { message: 'Something went wrong' } }, 500)
      : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
  })

  it('autosaves draft answers shortly after editing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const fetchMock = mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
      renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

      await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
      fireEvent.change(screen.getByLabelText('Main finding *'), { target: { value: 'Draft in progress' } })

      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/extraction-1/draft'))).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)

      await waitFor(() => {
        const draftCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/extraction-1/draft'))
        expect(draftCall).toBeTruthy()
        expect(JSON.parse(String(draftCall?.[1]?.body))).toEqual({ draft: { finding: 'Draft in progress' } })
      })
    } finally {
      vi.useRealTimers()
    }
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
