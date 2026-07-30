import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PublicationsPage } from '../PublicationsPage'
import { emptyResponse, jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const publications = [
  {
    id: 'publication-1',
    title: 'Urban Data in VR',
    authors: 'A. Author',
    abstract: null,
    publicationYear: 2025,
    venue: null,
    publicationType: null,
    doi: '10.1000/urban-vr',
    publisherUrl: 'https://publisher.example/urban-vr',
    keywords: null,
    isbn: null,
    issn: null,
    pubmedId: null,
    arxivId: null,
  },
  {
    id: 'publication-2',
    title: 'Paper without DOI',
    authors: null,
    abstract: null,
    publicationYear: null,
    venue: null,
    publicationType: null,
    doi: null,
    publisherUrl: null,
    keywords: null,
    isbn: null,
    issn: null,
    pubmedId: null,
    arxivId: null,
  },
]

describe('PublicationsPage', () => {
  it('renders normalized bibliographic metadata and opens external links in a new tab', async () => {
    mockFetch(() => jsonResponse(publications))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('Urban Data in VR')).toBeInTheDocument()
    const doiLink = screen.getByRole('link', { name: 'DOI' })
    expect(doiLink).toHaveAttribute('href', 'https://doi.org/10.1000/urban-vr')
    expect(doiLink).toHaveAttribute('target', '_blank')
    expect(doiLink).toHaveAttribute('rel', 'noopener noreferrer')

    const publisherLink = screen.getByRole('link', { name: 'Publisher link' })
    expect(publisherLink).toHaveAttribute('target', '_blank')
    expect(publisherLink).toHaveAttribute('rel', 'noopener noreferrer')

    const noDoiCard = screen.getByText('Paper without DOI').closest('li')
    expect(noDoiCard).toHaveTextContent('Unknown authors')

    expect(screen.getByText('2 publications in this project')).toBeInTheDocument()
  })

  it('shows singular count for a single publication', async () => {
    mockFetch(() => jsonResponse([publications[0]]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('1 publication in this project')).toBeInTheDocument()
  })

  it('clicking a publication opens an edit form that saves metadata', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.includes('/publications/publication-1')) {
        return jsonResponse({ ...publications[0], title: 'Urban Data in Virtual Reality' })
      }
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    fireEvent.click(await screen.findByRole('button', { name: 'Urban Data in VR' }))
    const titleInput = await screen.findByLabelText('Title')
    fireEvent.change(titleInput, { target: { value: 'Urban Data in Virtual Reality' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(String(patchCall?.[0])).toContain('/projects/p1/publications/publication-1')
      expect(JSON.parse(String(patchCall?.[1]?.body)).title).toBe('Urban Data in Virtual Reality')
    })
  })

  it('deleting a publication requires confirming a warning first', async () => {
    const fetchMock = mockFetch((_input, init) => {
      if (init?.method === 'DELETE') return emptyResponse(204)
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const card = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Delete' }))

    expect(within(card).getByRole('alert')).toHaveTextContent(/cannot be undone/)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    fireEvent.click(within(card).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    })
  })
})
