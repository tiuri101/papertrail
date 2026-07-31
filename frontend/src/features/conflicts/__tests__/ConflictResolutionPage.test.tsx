import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConflictResolutionPage } from '../ConflictResolutionPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const conflict = {
  publicationId: 'publication-1',
  publication: {
    id: 'publication-1',
    title: 'Urban Data in VR',
    authors: 'Doe, Jane',
    abstract: 'A study of urban data visualization in VR.',
    doi: '10.1/vr',
    publisherUrl: null,
  },
  decisions: [
    { reviewer: { id: 'r1', displayName: 'Reviewer One' }, outcome: 'include', notes: null },
    { reviewer: { id: 'r2', displayName: 'Reviewer Two' }, outcome: 'exclude', notes: 'Seems off-topic' },
  ],
}

describe('ConflictResolutionPage', () => {
  it("shows each reviewer's decision and notes for a conflicted publication", async () => {
    mockFetch(async () => jsonResponse([conflict]))
    renderWithProviders(<ConflictResolutionPage />, {
      route: '/projects/p1/conflicts/title_abstract',
      path: '/projects/:projectId/conflicts/:stage',
    })

    expect(await screen.findByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.getByText('1 unresolved publications')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View publication' })).toHaveAttribute('href', 'https://doi.org/10.1/vr')
    expect(screen.getByText('Reviewer One')).toBeInTheDocument()
    expect(screen.getByText('Reviewer Two')).toBeInTheDocument()
    expect(screen.getByText('Seems off-topic')).toBeInTheDocument()
  })

  it('records a separate administrator consensus decision with a note', async () => {
    let resolved = false
    const fetchMock = mockFetch(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/final')) {
        resolved = true
        return jsonResponse({ id: 'final-1', outcome: 'include' }, 201)
      }
      return jsonResponse(resolved ? [] : [conflict])
    })
    renderWithProviders(<ConflictResolutionPage />, {
      route: '/projects/p1/conflicts/title_abstract',
      path: '/projects/:projectId/conflicts/:stage',
    })

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.change(screen.getByLabelText('Resolution note'), { target: { value: 'Agreed after discussion' } })
    fireEvent.click(screen.getByRole('button', { name: 'Include' }))

    await waitFor(() => expect(screen.getByText('0 unresolved publications')).toBeInTheDocument())
    const postCall = fetchMock.mock.calls.find(([input, init]) => init?.method === 'POST' && String(input).endsWith('/final'))
    expect(postCall?.[0]).toBe('/api/v1/projects/p1/screening/title_abstract/publications/publication-1/final')
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      outcome: 'include',
      resolutionMethod: 'admin_consensus',
      note: 'Agreed after discussion',
    })
  })

  it('requests an additional reviewer for a publication', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/additional-reviewer')) {
        return jsonResponse({ workItemId: 'item-1', assignedReviewerId: 'r3' }, 201)
      }
      return jsonResponse([conflict])
    })
    renderWithProviders(<ConflictResolutionPage />, {
      route: '/projects/p1/conflicts/title_abstract',
      path: '/projects/:projectId/conflicts/:stage',
    })

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('button', { name: 'Add another reviewer' }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([input, init]) => init?.method === 'POST' && String(input).endsWith('/additional-reviewer'))
      expect(postCall?.[0]).toBe('/api/v1/projects/p1/screening/title_abstract/publications/publication-1/additional-reviewer')
    })
  })
})
