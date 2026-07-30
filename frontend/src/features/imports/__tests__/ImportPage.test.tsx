import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ImportPage } from '../ImportPage'
import { setCsrfToken } from '../../auth/session'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function fillSearchFields() {
  fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'IEEE Xplore' } })
  fireEvent.change(screen.getByLabelText('Search string'), { target: { value: 'virtual reality AND urban' } })
  fireEvent.change(screen.getByLabelText('Search date'), { target: { value: '2026-07-30' } })
}

describe('ImportPage', () => {
  it('does not offer a way to skip or reuse a documented search', async () => {
    mockFetch(() => jsonResponse([
      { id: 'search-1', sourceName: 'IEEE Xplore', query: 'virtual reality AND urban', searchDate: '2026-07-30', filters: null },
    ]))
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    await screen.findByLabelText('Bibliographic export')
    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument()
    expect(screen.queryByText(/Not documented/)).not.toBeInTheDocument()
  })

  it('documents the search and uploads the file in a single step, with credentials and CSRF protection', async () => {
    setCsrfToken('csrf-import')
    const searches: Array<{ id: string; sourceName: string; query: string; searchDate: string; filters: string | null }> = []
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/searches')) {
        const body = JSON.parse(String(init.body))
        const search = { id: 'search-1', ...body }
        searches.push(search)
        return jsonResponse(search, 201)
      }
      if (url.endsWith('/searches')) return jsonResponse(searches)
      return jsonResponse({ jobId: 'job-42' }, 202)
    })
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    await screen.findByLabelText('Database')
    fillSearchFields()
    const file = new File(['Title,Authors\nPaper,Author'], 'records.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Bibliographic export'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find(([input, callInit]) => String(input).endsWith('/searches') && callInit?.method === 'POST')
      expect(searchCall).toBeTruthy()
      expect(JSON.parse(String(searchCall?.[1]?.body))).toEqual({
        sourceName: 'IEEE Xplore',
        query: 'virtual reality AND urban',
        searchDate: '2026-07-30',
        filters: null,
      })
    })

    await waitFor(() => {
      const uploadCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/v1/projects/project-1/imports')
      expect(uploadCall).toBeTruthy()
      const [, init] = uploadCall!
      expect(init?.credentials).toBe('include')
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-import')
      expect(init?.body).toBeInstanceOf(FormData)
      expect((init?.body as FormData).get('searchSourceId')).toBe('search-1')
    })

    expect(await screen.findByText('Import queued: job-42')).toBeInTheDocument()
  })

  it('shows the server-provided import error', async () => {
    mockFetch((input, init) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/searches')) {
        return jsonResponse({ id: 'search-1', sourceName: 'IEEE Xplore', query: 'urban', searchDate: '2026-07-30', filters: null }, 201)
      }
      if (url.endsWith('/searches')) return jsonResponse([])
      return jsonResponse({ error: { message: 'Unsupported file format' } }, 415)
    })
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    await screen.findByLabelText('Database')
    fillSearchFields()
    fireEvent.change(screen.getByLabelText('Bibliographic export'), {
      target: { files: [new File(['bad'], 'records.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unsupported file format'))
  })

  it('lists previously documented searches for reference', async () => {
    mockFetch(() => jsonResponse([
      { id: 'search-1', sourceName: 'IEEE Xplore', query: 'virtual reality AND urban', searchDate: '2026-07-30', filters: null },
    ]))
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    expect(await screen.findByText('Previously documented searches')).toBeInTheDocument()
    expect(screen.getByText(/IEEE Xplore/)).toBeInTheDocument()
  })
})
