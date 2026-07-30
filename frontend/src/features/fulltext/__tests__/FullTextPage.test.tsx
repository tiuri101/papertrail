import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FullTextPage } from '../FullTextPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('FullTextPage', () => {
  it('updates manual retrieval status and refreshes the list', async () => {
    let status = 'not_yet_sought'
    const fetchMock = mockFetch(async (_input, init) => {
      if (init?.method === 'PUT') {
        status = JSON.parse(String(init.body)).status
        return jsonResponse({ id: 'retrieval-1', publicationId: 'publication-1', status, note: null })
      }
      return jsonResponse([{ id: 'retrieval-1', publicationId: 'publication-1', status, note: null }])
    })
    renderWithProviders(<FullTextPage />, { route: '/projects/p1/full-text', path: '/projects/:projectId/full-text' })

    const select = await screen.findByLabelText('Retrieval status for publication-1')
    fireEvent.change(select, { target: { value: 'available' } })

    await waitFor(() => {
      expect(screen.getByLabelText('Retrieval status for publication-1')).toHaveValue('available')
    })
    const updateCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(updateCall?.[0]).toBe('/api/v1/projects/p1/full-text/retrieval-1')
    expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({ status: 'available' })
  })
})
