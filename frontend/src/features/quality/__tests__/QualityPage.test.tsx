import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { QualityPage } from '../QualityPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const workItem = {
  id: 'quality-1',
  publicationId: 'publication-1',
  status: 'reserved',
  draft: {},
  publication: {
    title: 'Immersive Urban Analytics',
    authors: 'A. Author',
    publicationYear: 2024,
    doi: null,
    publisherUrl: 'https://publisher.example/paper',
  },
  fields: [
    { id: 'field-1', stableKey: 'design', label: 'Study design', fieldType: 'single_select', required: true, options: ['Strong', 'Weak'] },
    { id: 'field-2', stableKey: 'reporting', label: 'Reporting', fieldType: 'rating', required: true, options: [] },
  ],
}

describe('QualityPage', () => {
  it('fetches the next assessment automatically on load and renders publication context', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      return jsonResponse({})
    })
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open publisher page' })).toHaveAttribute('href', 'https://publisher.example/paper')
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')).toHaveLength(1)
  })

  it('shows how many assigned papers have been assessed', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/quality/progress')) return jsonResponse({ assigned: 5, completed: 2 })
      return jsonResponse({})
    })
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    expect(await screen.findByText('2 of 5 assigned papers assessed')).toBeInTheDocument()
  })

  it('disables submit until every required field is answered', async () => {
    mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    expect(screen.getByRole('button', { name: 'Submit Assessment' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Study design *'), { target: { value: 'Strong' } })
    expect(screen.getByRole('button', { name: 'Submit Assessment' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reporting *'), { target: { value: '4' } })
    expect(screen.getByRole('button', { name: 'Submit Assessment' })).toBeEnabled()
  })

  it('submits the answers, shows the returned total score, and fetches the next assessment', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      if (path.endsWith('/quality/quality-1') && init?.method === 'POST') return jsonResponse({ id: 'response-1', answers: {}, totalScore: 4, version: 1 }, 201)
      return jsonResponse({})
    })
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.change(screen.getByLabelText('Study design *'), { target: { value: 'Strong' } })
    fireEvent.change(screen.getByLabelText('Reporting *'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Assessment' }))

    await waitFor(() => {
      const submitCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/quality/quality-1'))
      expect(submitCall).toBeTruthy()
      expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({ answers: { design: 'Strong', reporting: 4 } })
    })
    expect(await screen.findByText('total score: 4')).toBeInTheDocument()
  })

  it('reports that the reviewer has completed all assigned assessment work, with a way back to the project', async () => {
    mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(null) : jsonResponse({}))
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    expect(await screen.findByText('You have completed all of your assigned assessment work.')).toBeInTheDocument()
    expect(screen.queryByText('Loading the next assessment…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to project' })).toBeInTheDocument()
  })

  it('reports a load error', async () => {
    mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ error: { message: 'Something went wrong' } }, 500)
      : jsonResponse({}))
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
  })

  it('loads a completed assessment for review and resubmits it as a corrected version', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/quality/quality-1') && !init?.method) {
        return jsonResponse({
          ...workItem,
          status: 'completed',
          draft: { design: 'Strong', reporting: 4 },
          currentResponse: {
            id: 'response-1', answers: { design: 'Strong', reporting: 4 },
            totalScore: 4, version: 1,
          },
        })
      }
      if (path.endsWith('/quality/quality-1') && init?.method === 'POST') {
        return jsonResponse({ id: 'response-2', answers: {}, totalScore: 8, version: 2 }, 201)
      }
      return jsonResponse({})
    })
    renderWithProviders(<QualityPage />, {
      route: '/projects/p1/quality/review/quality-1',
      path: '/projects/:projectId/quality/review/:itemId',
    })

    expect(await screen.findByLabelText('Study design *')).toHaveValue('Strong')
    expect(screen.getByRole('button', { name: 'Save corrected assessment' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Reporting *'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save corrected assessment' }))

    await waitFor(() => {
      const submitCall = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/quality/quality-1') && init?.method === 'POST'
      ))
      expect(submitCall).toBeTruthy()
      expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({
        answers: { design: 'Strong', reporting: 5 },
      })
    })
    expect(await screen.findByRole('button', { name: 'Save corrected assessment' })).toBeInTheDocument()
  })

  it('autosaves draft answers shortly after editing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const fetchMock = mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
      renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

      await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
      fireEvent.change(screen.getByLabelText('Study design *'), { target: { value: 'Strong' } })

      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/quality-1/draft'))).toBe(false)
      await vi.advanceTimersByTimeAsync(1000)

      await waitFor(() => {
        const draftCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/quality-1/draft'))
        expect(draftCall).toBeTruthy()
        expect(JSON.parse(String(draftCall?.[1]?.body))).toEqual({ draft: { design: 'Strong' } })
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
