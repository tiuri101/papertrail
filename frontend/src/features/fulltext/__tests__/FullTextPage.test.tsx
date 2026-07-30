import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FullTextPage } from '../FullTextPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const publicationA = {
  id: 'publication-1',
  title: 'Urban Data in VR',
  authors: 'Doe, Jane',
  publicationYear: 2024,
  doi: '10.1/vr',
  publisherUrl: null,
}

const publicationB = {
  id: 'publication-2',
  title: 'Remote Sensing Review',
  authors: null,
  publicationYear: null,
  doi: null,
  publisherUrl: null,
}

describe('FullTextPage', () => {
  it('groups publications by status with the default status first and available last', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null },
      { id: 'retrieval-2', publicationId: 'publication-2', publication: publicationB, status: 'available', note: null },
    ]
    mockFetch(async () => jsonResponse(retrievals))
    renderWithProviders(<FullTextPage />, { route: '/projects/p1/full-text', path: '/projects/:projectId/full-text' })

    expect(await screen.findByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Remote Sensing Review' })).toBeInTheDocument()
    expect(screen.getByText('1 of 2 addressed')).toBeInTheDocument()

    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(headings).toEqual(['Not yet sought (1)', 'Available (1)'])
  })

  it('updates a publication status and moves it into the matching group', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null },
    ]
    const fetchMock = mockFetch(async (_input, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        retrievals[0] = { ...retrievals[0], ...body }
        return jsonResponse(retrievals[0])
      }
      return jsonResponse(retrievals)
    })
    renderWithProviders(<FullTextPage />, { route: '/projects/p1/full-text', path: '/projects/:projectId/full-text' })

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    expect(screen.getByRole('link', { name: 'View publication' })).toHaveAttribute('href', 'https://doi.org/10.1/vr')

    fireEvent.change(screen.getByLabelText('Retrieval status for Urban Data in VR'), { target: { value: 'available' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const updateCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(updateCall?.[0]).toBe('/api/v1/projects/p1/full-text/retrieval-1')
      expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({ status: 'available', note: null })
    })
    expect(await screen.findByRole('heading', { name: 'Available (1)' })).toBeInTheDocument()
    expect(screen.getByText('1 of 1 addressed')).toBeInTheDocument()
  })

  it('saves a note alongside the current status', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'requested', note: null },
    ]
    const fetchMock = mockFetch(async (_input, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        retrievals[0] = { ...retrievals[0], ...body }
        return jsonResponse(retrievals[0])
      }
      return jsonResponse(retrievals)
    })
    renderWithProviders(<FullTextPage />, { route: '/projects/p1/full-text', path: '/projects/:projectId/full-text' })

    const noteField = await screen.findByLabelText('Note for Urban Data in VR')
    fireEvent.change(noteField, { target: { value: 'Requested via ILL' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const updateCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({ status: 'requested', note: 'Requested via ILL' })
    })
  })
})
