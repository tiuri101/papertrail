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
    abstract: 'A compact abstract for the immersive analytics study.',
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

    const publicationCard = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    const abstract = within(publicationCard).getByText('Abstract').closest('details') as HTMLDetailsElement
    expect(abstract).not.toHaveAttribute('open')
    expect(within(abstract).getByText('A compact abstract for the immersive analytics study.')).toBeInTheDocument()
    fireEvent.click(within(abstract).getByText('Abstract'))
    expect(abstract).toHaveAttribute('open')

    const noAbstractCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    expect(within(noAbstractCard).getByText('No abstract available.')).toBeInTheDocument()
  })

  it('hides the multi-select checkbox and management controls from regular users', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false })
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.queryByLabelText('Select Urban Data in VR')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Urban Data in VR' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByText('Metadata Enrichment')).not.toBeInTheDocument()
  })

  it('shows singular count for a single publication', async () => {
    mockFetch(() => jsonResponse([publications[0]]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('1 publication in this project')).toBeInTheDocument()
  })

  it('clicking a publication opens an edit form that saves metadata', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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

  it('triggers enrichment for a single publication with a DOI', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/publications/publication-1/enrich') && init?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1' }, 202)
      }
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const card = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Enrich Metadata' }))

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/publications/publication-1/enrich') && init?.method === 'POST')).toBe(true)
    })

    const noDoiCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    expect(within(noDoiCard).getByRole('button', { name: 'Enrich Metadata' })).toBeDisabled()
  })

  it('enriches selected publications and all publications missing metadata', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/publications/enrich') && init?.method === 'POST') {
        return jsonResponse({ jobIds: ['job-1'] }, 202)
      }
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    expect(screen.getByRole('button', { name: 'Enrich Selected (0)' })).toBeDisabled()

    const checkbox = screen.getByLabelText('Select Urban Data in VR')
    const card = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    expect(checkbox.compareDocumentPosition(screen.getByText('Urban Data in VR')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(checkbox)
    expect(card).toHaveClass('publication-card--selected')
    fireEvent.click(screen.getByRole('button', { name: 'Enrich Selected (1)' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/publications/enrich') && init?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ publicationIds: ['publication-1'], missingOnly: false })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Enrich All Records with Missing Metadata' }))
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/publications/enrich') && init?.method === 'POST')
      expect(calls).toHaveLength(2)
      expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ publicationIds: undefined, missingOnly: true })
    })
  })

  it('shows metadata conflicts side by side and resolves them', async () => {
    const conflicts = [
      {
        id: 'conflict-1',
        publicationId: 'publication-1',
        fieldName: 'title',
        currentValue: 'Urban Data in VR',
        proposedValue: 'Urban Data in Virtual Reality',
        sourceName: 'crossref',
        status: 'open',
      },
    ]
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse(conflicts)
      if (url.endsWith('/metadata-conflicts/conflict-1/resolve') && init?.method === 'POST') {
        return jsonResponse({ ...conflicts[0], status: 'accept_proposed' })
      }
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const heading = await screen.findByRole('heading', { name: 'Metadata Conflicts' })
    const panel = heading.closest('section') as HTMLElement
    await within(panel).findByText('title')
    expect(within(panel).getByText('Urban Data in VR')).toBeInTheDocument()
    expect(within(panel).getByText('Urban Data in Virtual Reality')).toBeInTheDocument()

    fireEvent.click(within(panel).getByRole('button', { name: 'Use Proposed Value' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/metadata-conflicts/conflict-1/resolve') && init?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ acceptProposed: true })
    })
  })
})
