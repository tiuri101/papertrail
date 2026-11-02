import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { emptyResponse, jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { BookmarkToggle } from '../BookmarkToggle'

describe('BookmarkToggle', () => {
  it('bookmarks an unbookmarked publication and reflects it immediately', async () => {
    let saved: string[] = []
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1/bookmarks/ids')) return jsonResponse({ publicationIds: saved })
      if (url.endsWith('/projects/p1/publications/pub1/bookmark') && init?.method === 'PUT') {
        saved = ['pub1']
        return emptyResponse()
      }
      return jsonResponse({})
    })
    renderWithProviders(<BookmarkToggle projectId="p1" publicationId="pub1" />)

    const button = await screen.findByRole('button', { name: 'Bookmark' })
    await waitFor(() => expect(button).toBeEnabled())
    expect(button).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(button)

    expect(await screen.findByRole('button', { name: 'Remove bookmark' })).toHaveAttribute('aria-pressed', 'true')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/p1/publications/pub1/bookmark',
      expect.objectContaining({ method: 'PUT' }),
    )
  })

  it('removes an existing bookmark', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1/bookmarks/ids')) return jsonResponse({ publicationIds: ['pub1'] })
      if (init?.method === 'DELETE') return emptyResponse()
      return jsonResponse({})
    })
    renderWithProviders(<BookmarkToggle projectId="p1" publicationId="pub1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove bookmark' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects/p1/publications/pub1/bookmark',
      expect.objectContaining({ method: 'DELETE' }),
    ))
  })

  it('reverts the optimistic state when saving fails', async () => {
    mockFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1/bookmarks/ids')) return jsonResponse({ publicationIds: [] })
      if (init?.method === 'PUT') return jsonResponse({ error: { message: 'nope' } }, 500)
      return jsonResponse({})
    })
    renderWithProviders(<BookmarkToggle projectId="p1" publicationId="pub1" />)

    const button = await screen.findByRole('button', { name: 'Bookmark' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByRole('button', { name: 'Bookmark' })).toHaveAttribute('aria-pressed', 'false'))
  })
})
