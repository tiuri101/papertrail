import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { emptyResponse, jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { BookmarksPage } from '../BookmarksPage'
import type { BookmarkItem } from '../useBookmarks'

const bookmark: BookmarkItem = {
  publicationId: 'pub1',
  projectId: 'p1',
  title: 'Immersive Urban Analytics',
  authors: 'Doe, J.',
  publicationYear: 2024,
  venue: 'IEEE VIS',
  doi: '10.1/immersive',
  publisherUrl: null,
  bookmarkedAt: '2026-10-01T10:00:00Z',
}

describe('BookmarksPage', () => {
  it('lists bookmarks across projects, each linking to its publication page', async () => {
    mockFetch(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/bookmarks')) {
        return jsonResponse([
          bookmark,
          { ...bookmark, publicationId: 'pub2', projectId: 'p2', title: 'Second Paper', doi: null },
        ])
      }
      if (url.endsWith('/projects/p1/bookmarks/ids')) return jsonResponse({ publicationIds: ['pub1'] })
      if (url.endsWith('/projects/p2/bookmarks/ids')) return jsonResponse({ publicationIds: ['pub2'] })
      return jsonResponse({})
    })
    renderWithProviders(<BookmarksPage />, { route: '/bookmarks', path: '/bookmarks' })

    const list = await screen.findByRole('list', { name: 'Bookmarked publications' })
    expect(within(list).getByRole('link', { name: 'Immersive Urban Analytics' }))
      .toHaveAttribute('href', '/projects/p1/publications/pub1')
    expect(within(list).getByRole('link', { name: 'Second Paper' }))
      .toHaveAttribute('href', '/projects/p2/publications/pub2')
    expect(within(list).getAllByText('IEEE VIS')).toHaveLength(2)
    await waitFor(() => expect(within(list).getAllByRole('button', { name: 'Remove bookmark' })).toHaveLength(2))
  })

  it('explains how to add a bookmark when there are none', async () => {
    mockFetch(async () => jsonResponse([]))
    renderWithProviders(<BookmarksPage />, { route: '/bookmarks', path: '/bookmarks' })

    expect(await screen.findByText(/You have no bookmarks yet/)).toBeInTheDocument()
  })

  it('removes the selected bookmarks in one request', async () => {
    let remaining = [bookmark, { ...bookmark, publicationId: 'pub2', title: 'Second Paper' }]
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v1/bookmarks/remove')) {
        const ids = JSON.parse(String(init?.body)).publicationIds as string[]
        remaining = remaining.filter((item) => !ids.includes(item.publicationId))
        return jsonResponse({ removedCount: ids.length })
      }
      if (url.endsWith('/api/v1/bookmarks')) return jsonResponse(remaining)
      if (url.endsWith('/bookmarks/ids')) return jsonResponse({ publicationIds: remaining.map((item) => item.publicationId) })
      return emptyResponse()
    })
    renderWithProviders(<BookmarksPage />, { route: '/bookmarks', path: '/bookmarks' })

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Second Paper' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Selected (1)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(screen.queryByRole('link', { name: 'Second Paper' })).not.toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/bookmarks/remove',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ publicationIds: ['pub2'] }) }),
    )
  })

  it('exports all bookmarks and offers the finished bundle for download', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v1/bookmarks/exports') && init?.method === 'POST') return jsonResponse({ jobId: 'job1' }, 202)
      if (url.endsWith('/api/v1/bookmarks/exports/job1')) {
        return jsonResponse({ jobId: 'job1', status: 'completed', errorMessage: null, filename: 'bookmarks.zip', publicationCount: 1 })
      }
      if (url.endsWith('/api/v1/bookmarks')) return jsonResponse([bookmark])
      if (url.endsWith('/bookmarks/ids')) return jsonResponse({ publicationIds: ['pub1'] })
      return emptyResponse()
    })
    renderWithProviders(<BookmarksPage />, { route: '/bookmarks', path: '/bookmarks' })

    fireEvent.click(await screen.findByRole('button', { name: 'Export All (1)' }))

    expect(await screen.findByRole('link', { name: 'Download bundle' }))
      .toHaveAttribute('href', '/api/v1/bookmarks/exports/job1/download')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/bookmarks/exports',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    )
  })
})
