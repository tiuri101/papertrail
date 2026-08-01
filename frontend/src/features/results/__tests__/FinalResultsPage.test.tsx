import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FinalResultsPage, type FinalResultsResponse } from '../FinalResultsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function baseResponse(): FinalResultsResponse {
  return {
    qualityEnabled: true,
    extractionFields: [{ stableKey: 'finding', label: 'Main Finding', fieldType: 'long_text' }],
    qualityFields: [{ stableKey: 'rigor', label: 'Rigor', fieldType: 'rating' }],
    items: [
      {
        publication: {
          id: 'pub-1',
          title: 'Alpha Study',
          authors: 'Adams, A',
          publicationYear: 2021,
          venue: 'Journal A',
          publicationType: null,
          doi: null,
          publisherUrl: null,
          keywords: null,
        },
        extraction: {
          status: 'completed',
          completedAt: '2026-07-01T00:00:00Z',
          reviewerName: 'Rin',
          answers: { finding: 'Alpha finding' },
        },
        quality: {
          status: 'completed',
          completedAt: '2026-07-02T00:00:00Z',
          reviewerName: 'Rin',
          totalScore: 4,
          answers: { rigor: 4 },
        },
      },
      {
        publication: {
          id: 'pub-2',
          title: 'Beta Study',
          authors: 'Brown, B',
          publicationYear: 2022,
          venue: 'Journal B',
          publicationType: null,
          doi: null,
          publisherUrl: null,
          keywords: null,
        },
        extraction: {
          status: 'available',
          completedAt: null,
          reviewerName: 'Sam',
          answers: {},
        },
        quality: {
          status: 'available',
          completedAt: null,
          reviewerName: 'Sam',
          totalScore: null,
          answers: {},
        },
      },
    ],
  }
}

describe('FinalResultsPage', () => {
  it('renders included publications with extraction and quality answers', async () => {
    mockFetch(() => jsonResponse(baseResponse()))
    renderWithProviders(<FinalResultsPage />, { route: '/projects/p1/results', path: '/projects/:projectId/results' })

    const alphaRow = (await screen.findByText('Alpha Study')).closest('tr') as HTMLElement
    expect(within(alphaRow).getByText('Alpha finding')).toBeInTheDocument()
    expect(within(alphaRow).getAllByText('4').length).toBe(2)

    const betaRow = screen.getByText('Beta Study').closest('tr') as HTMLElement
    expect(within(betaRow).getAllByText('Available').length).toBeGreaterThan(0)
  })

  it('filters rows by search text across metadata and answers', async () => {
    mockFetch(() => jsonResponse(baseResponse()))
    renderWithProviders(<FinalResultsPage />, { route: '/projects/p1/results', path: '/projects/:projectId/results' })

    await screen.findByText('Alpha Study')
    fireEvent.change(screen.getByPlaceholderText(/Filter by title/), { target: { value: 'Adams' } })

    expect(screen.getByText('Alpha Study')).toBeInTheDocument()
    expect(screen.queryByText('Beta Study')).not.toBeInTheDocument()
  })

  it('sorts rows when a column header is clicked', async () => {
    mockFetch(() => jsonResponse(baseResponse()))
    renderWithProviders(<FinalResultsPage />, { route: '/projects/p1/results', path: '/projects/:projectId/results' })

    await screen.findByText('Alpha Study')
    fireEvent.click(screen.getByRole('button', { name: /^Title/ }))

    const rows = screen.getAllByRole('row').slice(1)
    expect(within(rows[0]).getByText('Beta Study')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Alpha Study')).toBeInTheDocument()
  })

  it('omits quality columns when quality assessment is disabled', async () => {
    const response = baseResponse()
    response.qualityEnabled = false
    response.qualityFields = []
    for (const item of response.items) item.quality = null
    mockFetch(() => jsonResponse(response))
    renderWithProviders(<FinalResultsPage />, { route: '/projects/p1/results', path: '/projects/:projectId/results' })

    await screen.findByText('Alpha Study')
    expect(screen.queryByRole('button', { name: 'Rigor' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Quality Status' })).not.toBeInTheDocument()
  })
})
