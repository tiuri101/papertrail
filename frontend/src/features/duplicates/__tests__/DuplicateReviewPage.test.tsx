import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DuplicateReviewPage } from '../DuplicateReviewPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const candidate = {
  id: 'candidate-1',
  publicationA: {
    id: 'publication-a',
    title: 'A Study of Urban VR',
    authors: 'Doe, Jane',
    publicationYear: 2025,
    venue: 'CHI',
    doi: '10.1000/same',
  },
  publicationB: {
    id: 'publication-b',
    title: 'A study of urban VR',
    authors: 'Doe, J.',
    publicationYear: 2025,
    venue: 'CHI Extended Abstracts',
    doi: '10.1000/same',
  },
  matchReasons: ['exact_doi', 'similar_title_authors'],
  confidence: 0.98,
  status: 'unresolved',
}

describe('DuplicateReviewPage', () => {
  it('shows publication metadata and resolves a candidate as distinct', async () => {
    let resolved = false
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (init?.method === 'POST') {
        resolved = true
        return jsonResponse({ ...candidate, status: 'not_duplicate' })
      }
      return jsonResponse([{ ...candidate, status: resolved ? 'not_duplicate' : 'unresolved' }])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })

    expect(await screen.findByText('A Study of Urban VR')).toBeInTheDocument()
    expect(screen.getByText('A study of urban VR')).toBeInTheDocument()
    expect(screen.getByText(/Doe, Jane/)).toHaveTextContent('2025')
    expect(screen.getByText('CHI')).toBeInTheDocument()
    expect(screen.getByText('CHI Extended Abstracts')).toBeInTheDocument()
    const doiLinks = screen.getAllByRole('link', { name: 'DOI' })
    expect(doiLinks).toHaveLength(2)
    expect(doiLinks[0]).toHaveAttribute('href', 'https://doi.org/10.1000/same')
    expect(doiLinks[0]).toHaveAttribute('target', '_blank')
    expect(screen.getByText('Exact DOI, Similar title & authors — 98% match — unresolved')).toBeInTheDocument()
    expect(screen.getByText('A Study of Urban VR').closest('ul')).toHaveClass('card-list')

    fireEvent.click(screen.getByRole('button', { name: 'Not a Duplicate' }))

    await waitFor(() => expect(screen.getByText(/not_duplicate/)).toBeInTheDocument())
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(postCall?.[0]).toBe('/api/v1/projects/p1/duplicates/candidate-1/not-duplicate')
  })

  it('lets a regular project member (not a manager) resolve a candidate', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false })
      if (init?.method === 'POST') return jsonResponse({ ...candidate, status: 'not_duplicate' })
      return jsonResponse([candidate])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })

    expect(await screen.findByText('A Study of Urban VR')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Not a Duplicate' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
  })

  it('sends the selected canonical publication when merging', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      return init?.method === 'POST'
        ? jsonResponse({ ...candidate, status: 'merged' })
        : jsonResponse([candidate])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })
    await screen.findByText('A Study of Urban VR')

    const keepButtons = screen.getAllByRole('button', { name: 'Keep This One' })
    expect(keepButtons).toHaveLength(2)
    fireEvent.click(keepButtons[1])

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ canonicalPublicationId: 'publication-b' })
  })
})
