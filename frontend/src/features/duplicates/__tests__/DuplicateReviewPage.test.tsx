import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DuplicateReviewPage } from '../DuplicateReviewPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const candidate = {
  id: 'candidate-1',
  publicationAId: 'publication-a',
  publicationBId: 'publication-b',
  matchReasons: ['Exact DOI', 'Similar title'],
  confidence: 0.98,
  status: 'unresolved',
}

describe('DuplicateReviewPage', () => {
  it('shows duplicate evidence and resolves a candidate as distinct', async () => {
    let resolved = false
    const fetchMock = mockFetch(async (_input, init) => {
      if (init?.method === 'POST') {
        resolved = true
        return jsonResponse({ ...candidate, status: 'not_duplicate' })
      }
      return jsonResponse([{ ...candidate, status: resolved ? 'not_duplicate' : 'unresolved' }])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })

    expect(await screen.findByText('Exact DOI, Similar title — 98% — unresolved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Not a duplicate' }))

    await waitFor(() => expect(screen.getByText(/not_duplicate/)).toBeInTheDocument())
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(postCall?.[0]).toBe('/api/v1/projects/p1/duplicates/candidate-1/not-duplicate')
  })

  it('sends the selected canonical publication when merging', async () => {
    const fetchMock = mockFetch(async (_input, init) => init?.method === 'POST'
      ? jsonResponse({ ...candidate, status: 'merged' })
      : jsonResponse([candidate]))
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })
    await screen.findByText(/publication-a ↔ publication-b/)

    fireEvent.click(screen.getByRole('button', { name: 'Merge into B' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ canonicalPublicationId: 'publication-b' })
  })
})
