import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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

  it('disables submit until every required field is answered', async () => {
    mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    expect(screen.getByRole('button', { name: 'Submit assessment' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Study design *'), { target: { value: 'Strong' } })
    expect(screen.getByRole('button', { name: 'Submit assessment' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reporting *'), { target: { value: '4' } })
    expect(screen.getByRole('button', { name: 'Submit assessment' })).toBeEnabled()
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
    fireEvent.click(screen.getByRole('button', { name: 'Submit assessment' }))

    await waitFor(() => {
      const submitCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/quality/quality-1'))
      expect(submitCall).toBeTruthy()
      expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({ answers: { design: 'Strong', reporting: 4 } })
    })
    expect(await screen.findByText('Submitted — total score: 4')).toBeInTheDocument()
  })

  it('reports that no assessment work is currently available', async () => {
    mockFetch(async (input) => String(input).endsWith('/next') ? jsonResponse(null) : jsonResponse({}))
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    expect(await screen.findByText('No assessment work is currently available.')).toBeInTheDocument()
    expect(screen.queryByText('Loading the next assessment…')).not.toBeInTheDocument()
  })

  it('reports a load error', async () => {
    mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ error: { message: 'Something went wrong' } }, 500)
      : jsonResponse({}))
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
  })
})
