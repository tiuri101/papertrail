import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DuplicateQueuePage } from '../DuplicateQueuePage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const candidate = {
  id: 'cand-1',
  publicationA: {
    id: 'pub-a',
    title: 'A Study of Urban VR',
    authors: 'Doe, Jane',
    publicationYear: 2025,
    venue: 'CHI',
    doi: '10.1000/same',
  },
  publicationB: {
    id: 'pub-b',
    title: 'A study of urban VR',
    authors: 'Doe, J.',
    publicationYear: 2025,
    venue: 'CHI Extended Abstracts',
    doi: '10.1000/same',
  },
  matchReasons: ['exact_doi', 'similar_title_authors'],
  titleSimilarity: 95,
  authorSimilarity: 88,
  yearAgreement: true,
  confidence: 0.98,
  status: 'unresolved',
  autoResolved: false,
  resolvedById: null,
  resolvedByName: null,
  resolvedAt: null,
  resolutionNote: null,
  canonicalPublicationId: null,
  mergeId: null,
  reservedUntil: '2099-01-01T00:00:00Z',
  reservedById: 'me',
}

function renderPage() {
  return renderWithProviders(<DuplicateQueuePage />, {
    route: '/projects/p1/duplicates',
    path: '/projects/:projectId/duplicates',
  })
}

describe('DuplicateQueuePage', () => {
  it('shows one candidate pair at a time with its match evidence', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) {
        return jsonResponse({ id: 'p1', canManage: false, stage: 'duplicate_review' })
      }
      if (path.includes('/duplicates/next')) return jsonResponse(candidate)
      if (path.endsWith('/duplicates/progress')) {
        return jsonResponse({ remaining: 2, resolved: 5, total: 7 })
      }
      return jsonResponse([])
    })

    renderPage()

    expect(await screen.findByText('A Study of Urban VR')).toBeInTheDocument()
    expect(screen.getByText('A study of urban VR')).toBeInTheDocument()
    expect(screen.getByText('98% match')).toBeInTheDocument()
    expect(screen.getByText('Exact DOI')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Review or change past decisions' }),
    ).toHaveAttribute('href', '/projects/p1/duplicates/decisions')
  })

  it('resolves the open pair as distinct and advances the queue', async () => {
    let served = 0
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) {
        return jsonResponse({ id: 'p1', canManage: false, stage: 'duplicate_review' })
      }
      if (path.includes('/duplicates/next') && init?.method === 'POST') {
        served += 1
        return jsonResponse(served === 1 ? candidate : null)
      }
      if (path.endsWith('/duplicates/cand-1/not-duplicate') && init?.method === 'POST') {
        return jsonResponse({ ...candidate, status: 'not_duplicate' })
      }
      if (path.endsWith('/duplicates/progress')) {
        return jsonResponse({ remaining: 1, resolved: 6, total: 7 })
      }
      return jsonResponse([])
    })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Not a Duplicate' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([i, init]) => (
      String(i).endsWith('/duplicates/cand-1/not-duplicate') && init?.method === 'POST'
    ))).toBe(true))
    expect(await screen.findByText('Every duplicate pair in this project has been resolved.')).toBeInTheDocument()
  })

  it('sends the chosen canonical record when merging', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) {
        return jsonResponse({ id: 'p1', canManage: false, stage: 'duplicate_review' })
      }
      if (path.includes('/duplicates/next') && init?.method === 'POST') return jsonResponse(candidate)
      if (path.endsWith('/duplicates/cand-1/merge') && init?.method === 'POST') {
        return jsonResponse({ ...candidate, status: 'merged' })
      }
      if (path.endsWith('/duplicates/progress')) return jsonResponse({ remaining: 1, resolved: 0, total: 1 })
      return jsonResponse([])
    })

    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Keep Record B' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([i, init]) => (
      String(i).endsWith('/duplicates/cand-1/merge') && init?.method === 'POST'
    ))).toBe(true))
    const call = fetchMock.mock.calls.find(([i]) => String(i).endsWith('/duplicates/cand-1/merge'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ canonicalPublicationId: 'pub-b' })
  })

  it('offers duplicate detection only to a manager still in the stage', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) {
        return jsonResponse({ id: 'p1', canManage: true, stage: 'duplicate_review' })
      }
      if (path.includes('/duplicates/next')) return jsonResponse(candidate)
      if (path.endsWith('/duplicates/progress')) return jsonResponse({ remaining: 1, resolved: 0, total: 1 })
      return jsonResponse([])
    })

    renderPage()

    expect(await screen.findByRole('button', { name: 'Re-run Duplicate Detection' })).toBeInTheDocument()
  })
})
