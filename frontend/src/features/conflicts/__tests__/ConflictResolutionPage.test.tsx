import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ConflictResolutionPage } from '../ConflictResolutionPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ConflictResolutionPage', () => {
  it('records a separate administrator consensus decision', async () => {
    let resolved = false
    const fetchMock = mockFetch(async (_input, init) => {
      if (init?.method === 'POST') {
        resolved = true
        return jsonResponse({ id: 'final-1', outcome: 'include' }, 201)
      }
      return jsonResponse({ publicationIds: resolved ? [] : ['publication-1'] })
    })
    renderWithProviders(<ConflictResolutionPage />, {
      route: '/projects/p1/conflicts/title_abstract',
      path: '/projects/:projectId/conflicts/:stage',
    })

    expect(await screen.findByText('1 unresolved publications')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'include' }))

    await waitFor(() => expect(screen.getByText('0 unresolved publications')).toBeInTheDocument())
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(postCall?.[0]).toBe('/api/v1/projects/p1/screening/title_abstract/publications/publication-1/final')
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      outcome: 'include',
      resolutionMethod: 'admin_consensus',
      note: null,
    })
  })
})
