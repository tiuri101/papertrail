import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PublicationsPage } from '../PublicationsPage'
import type { Publication } from '../publicationShared'
import { emptyResponse, jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const publications: Publication[] = [
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
    fullText: { available: false },
    screeningStatus: { titleAbstract: 'include', fullText: 'exclude' },
    extractionStatus: 'completed',
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
    fullText: { available: false },
    screeningStatus: { titleAbstract: null, fullText: null },
    extractionStatus: 'not_started',
  },
]

// PublicationsPage now embeds BrowserPdfRetrievalPanel, which polls its own
// endpoints regardless of what a given test cares about -- keep them
// answered so unrelated tests don't have to know about PDF retrieval.
function pdfRetrievalDefault(url: string) {
  if (url.endsWith('/browser-agents')) return jsonResponse([])
  if (url.endsWith('/pdf-retrieval-batches/missing-count')) return jsonResponse({ missingCount: 0 })
  if (url.endsWith('/pdf-retrieval-batches')) return jsonResponse([])
  return undefined
}

type TestPublication = Publication

function searchable(publication: TestPublication): string {
  return [
    publication.title,
    publication.authors,
    publication.abstract,
    publication.publicationYear,
    publication.venue,
    publication.publicationType,
    publication.doi,
    publication.publisherUrl,
    publication.keywords,
    publication.isbn,
    publication.issn,
    publication.pubmedId,
    publication.arxivId,
  ].filter((value) => value !== null && value !== undefined).join(' ').toLowerCase()
}

function matching(query: URLSearchParams, all: TestPublication[]): TestPublication[] {
  const search = (query.get('search') ?? '').toLowerCase()
  const titleAbstract = query.get('titleAbstract')
  const fullText = query.get('fullText')
  const pdfStatus = query.get('pdfStatus')
  const matches = all.filter((publication) => {
    if (search && !searchable(publication).includes(search)) return false
    if (titleAbstract && (publication.screeningStatus?.titleAbstract ?? 'pending') !== titleAbstract) return false
    if (fullText && (publication.screeningStatus?.fullText ?? 'pending') !== fullText) return false
    if (pdfStatus === 'available' && !publication.fullText?.available) return false
    if (pdfStatus === 'unavailable' && publication.fullText?.available) return false
    return true
  })
  const sort = query.get('sort') ?? 'title'
  const direction = query.get('direction') ?? 'asc'
  const sortValue = (publication: TestPublication): string | number => {
    if (sort === 'authors') return (publication.authors ?? '').toLowerCase()
    if (sort === 'year') return publication.publicationYear ?? -Infinity
    if (sort === 'source') return (publication.venue ?? '').toLowerCase()
    if (sort === 'pdf') return publication.fullText?.available ? 1 : 0
    if (sort === 'stage') return publication.screeningStatus?.titleAbstract ? 1 : 0
    return publication.title.toLowerCase()
  }
  return [...matches].sort((left, right) => {
    const leftValue = sortValue(left)
    const rightValue = sortValue(right)
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue))
    return direction === 'asc' ? comparison : -comparison
  })
}

/**
 * Stands in for `backend/app/publications/listing.py`.
 *
 * The page no longer holds the project's publications: search, the three
 * filters, the six sort keys and paging are all request parameters now, so a
 * test that wants to exercise them has to be answered the way the server
 * answers them.
 */
function servePublications(url: string, all: TestPublication[] = publications) {
  const query = new URL(url, 'http://localhost').searchParams
  const matches = matching(query, all)
  if (new URL(url, 'http://localhost').pathname.endsWith('/publications/ids')) {
    return jsonResponse({ ids: matches.map((item) => item.id), total: matches.length })
  }
  const pageSize = Number(query.get('pageSize') ?? 50)
  const page = Number(query.get('page') ?? 1)
  return jsonResponse({
    items: matches.slice((page - 1) * pageSize, page * pageSize),
    total: matches.length,
    projectTotal: all.length,
    missingPdfCount: all.filter((item) => !item.fullText?.available).length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(matches.length / pageSize)),
    hasMore: page * pageSize < matches.length,
  })
}

describe('PublicationsPage', () => {
  it('renders normalized bibliographic metadata as a table row and links to the detail page', async () => {
    mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input)))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('Urban Data in VR')).toBeInTheDocument()

    const noDoiCard = screen.getByText('Paper without DOI').closest('li')
    expect(noDoiCard).toHaveTextContent('Unknown authors')

    expect(screen.getByText('2 publications in this project')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Add Publication' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 papers missing a PDF' })).toBeInTheDocument()

    const publicationCard = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    expect(screen.getByLabelText('Sort by')).toHaveValue('title:asc')
    expect(document.querySelector('.publication-list__header')).not.toBeInTheDocument()
    expect(within(publicationCard).getByText('2025')).toBeInTheDocument()
    expect(within(publicationCard).getByRole('link', { name: 'Urban Data in VR' })).toHaveAttribute(
      'href', '/projects/p1/publications/publication-1',
    )
    expect(within(publicationCard).getByRole('link', { name: 'DOI' })).toHaveAttribute(
      'href', 'https://doi.org/10.1000/urban-vr',
    )
  })

  it('shows management controls to regular project members, not just owners', async () => {
    mockFetch((input) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const card = await screen.findByText('Urban Data in VR').then((element) => element.closest('li') as HTMLElement)
    expect(within(card).getByLabelText('Select Urban Data in VR')).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'More actions for Urban Data in VR' }))
    const menu = screen.getByRole('menu', { name: 'More actions for Urban Data in VR' })
    expect(within(menu).getByRole('link', { name: 'Edit Metadata' })).toHaveAttribute('href', '/projects/p1/publications/publication-1?edit=1')
    expect(within(menu).getByRole('button', { name: 'Enrich Metadata' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Metadata Tools' }))
    expect(await screen.findByText('Metadata Enrichment')).toBeInTheDocument()
  })

  it('hides the multi-select checkbox and management controls when publication management is unavailable', async () => {
    mockFetch((input) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false, canManagePublications: false })
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const card = await screen.findByText('Urban Data in VR').then((element) => element.closest('li') as HTMLElement)
    expect(screen.queryByLabelText('Select Urban Data in VR')).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'More actions for Urban Data in VR' })).not.toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.queryByText('Metadata Enrichment')).not.toBeInTheDocument()
  })

  it('adds a publication from the Add Publication tab', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/publications') && init?.method === 'POST') {
        return jsonResponse({ id: 'publication-3', title: 'A Manually Added Paper' }, 201)
      }
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    fireEvent.click(screen.getByRole('tab', { name: 'Add Publication' }))

    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'A Manually Added Paper' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Publication' }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([callInput, callInit]) => String(callInput).endsWith('/publications') && callInit?.method === 'POST')
      expect(postCall).toBeTruthy()
      expect(JSON.parse(String(postCall?.[1]?.body)).title).toBe('A Manually Added Paper')
    })
    expect(await screen.findByText('Publication added.')).toBeInTheDocument()
  })

  it('shows singular count for a single publication', async () => {
    mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input), [publications[0]]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('1 publication in this project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1 paper missing a PDF' })).toBeInTheDocument()
  })

  it('shows when every publication has an attached PDF', async () => {
    mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input), [
      { ...publications[0], fullText: { available: true } },
    ]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByRole('button', { name: 'All papers have a PDF' })).toBeDisabled()
  })

  it('deleting a publication requires confirming a warning first', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (init?.method === 'DELETE') return emptyResponse(204)
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const card = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'More actions for Urban Data in VR' }))
    const menu = screen.getByRole('menu', { name: 'More actions for Urban Data in VR' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Delete' }))

    expect(within(menu).getByRole('alert')).toHaveTextContent(/cannot be undone/)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

    fireEvent.click(within(menu).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true)
    })
  })

  it('triggers enrichment for a single publication with a DOI', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/publications/publication-1/enrich') && init?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1' }, 202)
      }
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const card = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'More actions for Urban Data in VR' }))
    const menu = screen.getByRole('menu', { name: 'More actions for Urban Data in VR' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Enrich Metadata' }))

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).endsWith('/publications/publication-1/enrich') && init?.method === 'POST')).toBe(true)
    })

    const noDoiCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    fireEvent.click(within(noDoiCard).getByRole('button', { name: 'More actions for Paper without DOI' }))
    const noDoiMenu = screen.getByRole('menu', { name: 'More actions for Paper without DOI' })
    expect(within(noDoiMenu).getByRole('button', { name: 'Enrich Metadata' })).toBeDisabled()
  })

  it('enriches selected publications and all publications missing metadata', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/publications/enrich') && init?.method === 'POST') {
        return jsonResponse({ jobIds: ['job-1'] }, 202)
      }
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    expect(screen.queryByRole('button', { name: /Enrich Selected Metadata/ })).not.toBeInTheDocument()

    const checkbox = screen.getByLabelText('Select Urban Data in VR')
    const card = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    expect(checkbox.compareDocumentPosition(screen.getByText('Urban Data in VR')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(checkbox)
    expect(card).toHaveAttribute('data-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Enrich Selected Metadata (1)' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/publications/enrich') && init?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ publicationIds: ['publication-1'], missingOnly: false })
    })

    fireEvent.click(screen.getByRole('tab', { name: 'Metadata Tools' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Enrich All Records with Missing Metadata' }))
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
        publication: publications[0],
      },
    ]
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse(conflicts)
      if (url.endsWith('/metadata-conflicts/conflict-1/resolve') && init?.method === 'POST') {
        return jsonResponse({ ...conflicts[0], status: 'accept_proposed' })
      }
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    fireEvent.click(await screen.findByRole('tab', { name: 'Metadata Tools' }))
    const heading = await screen.findByRole('heading', { name: 'Metadata Conflicts' })
    const panel = heading.closest('section') as HTMLElement
    expect(within(panel).getByRole('heading', { name: 'Current Value' })).toBeInTheDocument()
    expect(within(panel).getByRole('heading', { name: 'Proposed Value' })).toBeInTheDocument()
    expect(within(panel).getAllByText('Urban Data in VR').length).toBeGreaterThan(0)
    expect(within(panel).getByText('Urban Data in Virtual Reality')).toBeInTheDocument()
    expect(within(panel).getByRole('heading', { name: 'Why was this proposed?' })).toBeInTheDocument()
    expect(within(panel).getByText(/Crossref returned a different title/)).toBeInTheDocument()
    fireEvent.click(within(panel).getByText('All publication metadata'))
    expect(within(panel).getByText('A. Author')).toBeInTheDocument()

    fireEvent.click(within(panel).getByRole('button', { name: 'Use Proposed Value' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/metadata-conflicts/conflict-1/resolve') && init?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ acceptProposed: true })
    })
  })

  it('lets a manager sweep merge conflicts for automatic resolution via provider', async () => {
    const conflicts = [
      {
        id: 'conflict-1',
        publicationId: 'publication-1',
        fieldName: 'venue',
        currentValue: 'Journal of Tests',
        proposedValue: 'J. of Tests',
        sourceName: 'merge',
        status: 'open',
        publication: publications[0],
      },
    ]
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse(conflicts)
      if (url.endsWith('/metadata-conflicts/resolve-via-provider') && init?.method === 'POST') {
        return jsonResponse({ jobIds: ['job-1'], queuedCount: 1 }, 202)
      }
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    fireEvent.click(await screen.findByRole('tab', { name: 'Metadata Tools' }))
    const heading = await screen.findByRole('heading', { name: 'Metadata Conflicts' })
    const panel = heading.closest('section') as HTMLElement

    fireEvent.click(within(panel).getByRole('button', { name: 'Resolve via Provider' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/metadata-conflicts/resolve-via-provider') && init?.method === 'POST')
      expect(call).toBeTruthy()
    })
    expect(await within(panel).findByText('Queued 1 publication for provider resolution. Check back shortly.')).toBeInTheDocument()
  })

  it('does not offer the provider sweep when no conflict came from a merge', async () => {
    const conflicts = [
      {
        id: 'conflict-1',
        publicationId: 'publication-1',
        fieldName: 'title',
        currentValue: 'Urban Data in VR',
        proposedValue: 'Urban Data in Virtual Reality',
        sourceName: 'crossref',
        status: 'open',
        publication: publications[0],
      },
    ]
    mockFetch((input) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse(conflicts)
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    fireEvent.click(await screen.findByRole('tab', { name: 'Metadata Tools' }))
    await screen.findByRole('heading', { name: 'Metadata Conflicts' })

    expect(screen.queryByRole('button', { name: 'Resolve via Provider' })).not.toBeInTheDocument()
  })

  it('opens directly on the metadata tab when linked with ?tab=metadata', async () => {
    const conflicts = [
      {
        id: 'conflict-1',
        publicationId: 'publication-1',
        fieldName: 'title',
        currentValue: 'Urban Data in VR',
        proposedValue: 'Urban Data in Virtual Reality',
        sourceName: 'crossref',
        status: 'open',
        publication: publications[0],
      },
    ]
    mockFetch((input) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse(conflicts)
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, {
      route: '/projects/p1/publications?tab=metadata#metadata-conflicts',
      path: '/projects/:projectId/publications',
    })

    expect(await screen.findByRole('tab', { name: 'Metadata Tools', selected: true })).toBeInTheDocument()
    const heading = await screen.findByRole('heading', { name: 'Metadata Conflicts' })
    expect(heading.closest('section')).toHaveAttribute('id', 'metadata-conflicts')
  })

  it('shows a single at-a-glance stage badge for each publication and filters by underlying screening status', async () => {
    mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input)))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    // publications[0]: titleAbstract include, fullText exclude -> Excluded
    const includedCard = await screen.findByText('Urban Data in VR').then((el) => el.closest('li') as HTMLElement)
    expect(within(includedCard).getByText('Excluded')).toBeInTheDocument()

    // publications[1]: titleAbstract pending -> New
    const pendingCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    expect(within(pendingCard).getByText('New')).toBeInTheDocument()

    expect(screen.getByText('2 publications in this project')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Title/Abstract stage'), { target: { value: 'include' } })
    await waitFor(() => {
      expect(screen.queryByText('Paper without DOI')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    // The "of N" total counts the project, not the page, so it survives the
    // list itself being narrowed.
    expect(screen.getByText('1 of 2 publications match your filters')).toBeInTheDocument()
  })

  it('sends the filter as a query parameter rather than narrowing a full list', async () => {
    const fetchMock = mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input)))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const firstListCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.includes('/publications?'))
    expect(firstListCall).toContain('sort=title')
    expect(firstListCall).toContain('direction=asc')
    expect(firstListCall).toContain('page=1')
    expect(firstListCall).toContain('pageSize=50')

    fireEvent.change(screen.getByLabelText('Title/Abstract stage'), { target: { value: 'include' } })
    fireEvent.change(screen.getByLabelText('PDF status'), { target: { value: 'unavailable' } })

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input))
      expect(urls.some((url) => url.includes('titleAbstract=include') && url.includes('pdfStatus=unavailable'))).toBe(true)
    })
  })

  it('shows the retrieval failure reason as the stage badge when full text could not be retrieved', async () => {
    const unretrievable = {
      ...publications[0],
      id: 'publication-3',
      title: 'Unreachable Paper',
      fullText: { available: false, retrievalStatus: 'not_found' },
      screeningStatus: { titleAbstract: 'include', fullText: null },
    }
    mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input), [unretrievable]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const card = await screen.findByText('Unreachable Paper').then((el) => el.closest('li') as HTMLElement)
    expect(within(card).getByText('Not found')).toBeInTheDocument()
  })

  it('searches across publication metadata', async () => {
    mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input)))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    fireEvent.change(screen.getByLabelText('Search publications'), { target: { value: '10.1000/urban-vr' } })

    await waitFor(() => {
      expect(screen.queryByText('Paper without DOI')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 publications match your filters')).toBeInTheDocument()
  })

  it('debounces the search box into one request per pause in typing', async () => {
    const fetchMock = mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input)))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const searchRequests = () => fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes('search='))

    const box = screen.getByLabelText('Search publications')
    for (const value of ['u', 'ur', 'urb', 'urba', 'urban']) {
      fireEvent.change(box, { target: { value } })
    }
    // Nothing has been asked of the server yet: the intermediate prefixes
    // never become requests.
    expect(searchRequests()).toHaveLength(0)

    await waitFor(() => {
      expect(searchRequests()).toHaveLength(1)
    })
    expect(searchRequests()[0]).toContain('search=urban')
  })

  it('filters publications by PDF status', async () => {
    mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input), [
      { ...publications[0], fullText: { available: true } },
      { ...publications[1], fullText: { available: false } },
    ]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()

    const pdfStatus = screen.getByLabelText('PDF status')
    const missingPdfButton = screen.getByRole('button', { name: '1 paper missing a PDF' })
    expect(pdfStatus.closest('label')?.nextElementSibling).toBe(missingPdfButton)

    fireEvent.click(missingPdfButton)
    expect(pdfStatus).toHaveValue('unavailable')
    expect(missingPdfButton).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      expect(screen.queryByText('Urban Data in VR')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()
    // The shortcut keeps counting the project's gap, not the filtered page.
    expect(missingPdfButton).toHaveTextContent('1 paper missing a PDF')

    fireEvent.click(missingPdfButton)
    expect(pdfStatus).toHaveValue('')
    expect(missingPdfButton).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => {
      expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    })
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()

    fireEvent.change(pdfStatus, { target: { value: 'available' } })
    await waitFor(() => {
      expect(screen.queryByText('Paper without DOI')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 publications match your filters')).toBeInTheDocument()

    fireEvent.change(pdfStatus, { target: { value: 'unavailable' } })
    await waitFor(() => {
      expect(screen.queryByText('Urban Data in VR')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()

    fireEvent.change(pdfStatus, { target: { value: '' } })
    await waitFor(() => {
      expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    })
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()
  })

  it('bulk-deletes the selected publications after confirming', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      if (url.endsWith('/publications/delete') && init?.method === 'POST') {
        return jsonResponse({ deletedCount: 1 })
      }
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    expect(screen.queryByRole('button', { name: /Delete Selected/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Select Urban Data in VR'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Selected (1)' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be undone/)
    expect(fetchMock.mock.calls.some(([, callInit]) => callInit?.method === 'POST' && String(callInit?.body).includes('publicationIds'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([callInput, callInit]) => String(callInput).endsWith('/publications/delete') && callInit?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ publicationIds: ['publication-1'] })
    })
  })

  it('selects and deselects the publications on the current page with Select All', async () => {
    mockFetch((input) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    expect(screen.queryByRole('button', { name: /Enrich Selected Metadata/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Select All (2)'))
    expect(screen.getByLabelText('Select Urban Data in VR')).toBeChecked()
    expect(screen.getByLabelText('Select Paper without DOI')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Enrich Selected Metadata (2)' })).not.toBeDisabled()

    fireEvent.click(screen.getByLabelText('Select All (2)'))
    expect(screen.getByLabelText('Select Urban Data in VR')).not.toBeChecked()
    expect(screen.getByLabelText('Select Paper without DOI')).not.toBeChecked()
    expect(screen.queryByRole('button', { name: /Enrich Selected Metadata/ })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Title/Abstract stage'), { target: { value: 'include' } })
    await waitFor(() => {
      expect(screen.getByLabelText('Select All (1)')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByLabelText('Select All (1)'))
    expect(screen.getByLabelText('Select Urban Data in VR')).toBeChecked()
  })

  it('keeps a selection while paging and can select every match beyond the page', async () => {
    const many = Array.from({ length: 3 }, (_, index) => ({
      ...publications[1],
      id: `publication-${index + 10}`,
      title: `Paper ${index}`,
    }))
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      // Force one publication per page so paging is observable.
      const paged = new URL(url, 'http://localhost')
      if (paged.searchParams.has('pageSize')) paged.searchParams.set('pageSize', '1')
      return servePublications(paged.toString(), many)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Paper 0')
    expect(screen.getByText('Page 1 of 3 (3 publications)')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Select Paper 0'))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    await screen.findByText('Paper 1')
    // The selection is by id, so it outlives the page it was made on.
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    // "Select all N matching" fetches just the ids -- never the records.
    fireEvent.click(screen.getByRole('button', { name: 'Select all 3 matching' }))
    await waitFor(() => {
      expect(screen.getByText('3 selected')).toBeInTheDocument()
    })
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/publications/ids'))).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
  })

  it('returns to the first page when the filters or the sort order change', async () => {
    const many = Array.from({ length: 3 }, (_, index) => ({
      ...publications[1],
      id: `publication-${index + 10}`,
      title: `Paper ${index}`,
    }))
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      const paged = new URL(url, 'http://localhost')
      if (paged.searchParams.has('pageSize')) paged.searchParams.set('pageSize', '1')
      return servePublications(paged.toString(), many)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Paper 0')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Paper 1')
    expect(screen.getByText('Page 2 of 3 (3 publications)')).toBeInTheDocument()

    // Page 3 of a narrowed result may not exist; staying there would show an
    // empty list over a non-empty match.
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'title:desc' } })
    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3 (3 publications)')).toBeInTheDocument()
    })
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('direction=desc') && String(input).includes('page=1'))).toBe(true)
  })

  it('bulk-uploads and auto-matches PDFs against the whole project without any selection', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      if (url.endsWith('/publications/pdfs') && init?.method === 'POST') {
        return jsonResponse({
          importBatchId: 'batch-1',
          summary: { total: 2, matched: 1, ambiguous: 1, unmatched: 0, duplicate: 0, conflict_existing_pdf: 0, invalid: 0, skipped: 0 },
        }, 201)
      }
      if (url.includes('/pdf-matches')) {
        return jsonResponse({
          importBatchId: 'batch-1',
          summary: { total: 2, matched: 1, ambiguous: 1, unmatched: 0, duplicate: 0, conflict_existing_pdf: 0, invalid: 0, skipped: 0 },
          items: [],
          publications: [],
        })
      }
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    fireEvent.click(screen.getByRole('tab', { name: 'PDF Retrieval' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Bulk Attach PDFs' }))

    const files = [
      new File(['pdf-1'], 'paper-1.pdf', { type: 'application/pdf' }),
      new File(['pdf-2'], 'paper-2.pdf', { type: 'application/pdf' }),
    ]
    fireEvent.change(screen.getByLabelText('PDF files'), { target: { files } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload PDFs' }))

    await waitFor(() => {
      const uploadCall = fetchMock.mock.calls.find(([callInput]) => String(callInput) === '/api/v1/projects/p1/publications/pdfs')
      expect(uploadCall).toBeTruthy()
      const [, init] = uploadCall!
      expect(init?.credentials).toBe('include')
      expect((init?.body as FormData).getAll('pdfs')).toEqual(files)
    })

    expect(await screen.findByText('2 files processed · 1 matched · 1 need review')).toBeInTheDocument()
    expect(await screen.findByText('Review PDF matches')).toBeInTheDocument()
  })

  it('shows per-publication export links, gating PDF export on availability', async () => {
    mockFetch((input) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return servePublications(url, [
        { ...publications[0], fullText: { available: true, document: { pageCount: 12 } } },
        publications[1],
      ])
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const withPdfCard = await screen.findByText('Urban Data in VR').then((el) => el.closest('li') as HTMLElement)
    fireEvent.click(within(withPdfCard).getByRole('button', { name: 'More actions for Urban Data in VR' }))
    const withPdfMenu = screen.getByRole('menu', { name: 'More actions for Urban Data in VR' })
    expect(within(withPdfMenu).getByRole('link', { name: /Export BibTeX/ })).toHaveAttribute(
      'href', '/api/v1/projects/p1/publications/publication-1/export/bib',
    )
    expect(within(withPdfMenu).getByRole('link', { name: /Export PDF/ })).toHaveAttribute(
      'href', '/api/v1/projects/p1/publications/publication-1/export/pdf',
    )
    expect(within(withPdfCard).getByRole('link', { name: 'PDF' })).toHaveAttribute(
      'href', '/api/v1/projects/p1/publications/publication-1/full-text/content',
    )

    const withoutPdfCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    fireEvent.click(within(withoutPdfCard).getByRole('button', { name: 'More actions for Paper without DOI' }))
    const withoutPdfMenu = screen.getByRole('menu', { name: 'More actions for Paper without DOI' })
    expect(within(withoutPdfMenu).getByRole('link', { name: /Export BibTeX/ })).toBeInTheDocument()
    expect(within(withoutPdfMenu).queryByRole('link', { name: /Export PDF/ })).not.toBeInTheDocument()
    expect(within(withoutPdfCard).getByText('No PDF')).toBeInTheDocument()
  })

  it('bulk-exports selected publications as a PDF+BibTeX bundle and links the finished download', async () => {
    let jobStatus = 'queued'
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      if (url.endsWith('/exports') && init?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1' })
      }
      if (url.endsWith('/jobs')) {
        return jsonResponse([
          {
            id: 'job-1',
            jobType: 'generate_export',
            status: jobStatus,
            progressCurrent: 0,
            progressTotal: 0,
            progressMessage: null,
            errorMessage: null,
            createdAt: '2026-08-10T00:00:00Z',
            completedAt: jobStatus === 'completed' ? '2026-08-10T00:01:00Z' : null,
            result: jobStatus === 'completed' ? { artifactId: 'artifact-1' } : null,
          },
        ])
      }
      return servePublications(url)
    })
    const { queryClient } = renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    fireEvent.click(screen.getByLabelText('Select Urban Data in VR'))
    fireEvent.click(screen.getByRole('button', { name: 'Export Selected (1)' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/exports') && init?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ exportType: 'pdf_bundle', publicationIds: ['publication-1'] })
    })
    expect(await screen.findByText(/Preparing export bundle/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Download bundle' })).not.toBeInTheDocument()

    jobStatus = 'completed'
    await queryClient.invalidateQueries({ queryKey: ['jobs', 'p1'] })

    expect(await screen.findByRole('link', { name: 'Download bundle' })).toHaveAttribute(
      'href', '/api/v1/projects/p1/exports/artifact-1/download',
    )
    expect(screen.queryByText(/Preparing export bundle/)).not.toBeInTheDocument()
  })

  it('lets a manager attach a PDF from the publications page', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      const pdfRetrieval = pdfRetrievalDefault(url)
      if (pdfRetrieval) return pdfRetrieval
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      if (url.endsWith('/publications/publication-1/full-text') && init?.method === 'POST') {
        return jsonResponse({ available: true, document: { id: 'doc-1', originalFilename: 'paper.pdf', fileSize: 1024, uploadedAt: '2026-08-08T10:00:00Z', uploadedBy: null, isActive: true, removedAt: null } }, 201)
      }
      if (url.endsWith('/publications/publication-1/full-text')) return jsonResponse({ available: false, document: null })
      return servePublications(url)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const card = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'More actions for Urban Data in VR' }))
    const menu = screen.getByRole('menu', { name: 'More actions for Urban Data in VR' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Attach PDF' }))

    expect(await within(card).findByText('No PDF attached')).toBeInTheDocument()
    const file = new File(['pdf'], 'paper.pdf', { type: 'application/pdf' })
    fireEvent.change(within(card).getByLabelText('Choose PDF'), { target: { files: [file] } })

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/publications/publication-1/full-text') && init?.method === 'POST')
      expect(post).toBeTruthy()
    })
    expect(await within(card).findByRole('link', { name: 'View PDF' })).toBeInTheDocument()
  })

  it('sorts publication cards with a dropdown and does not show column headers', async () => {
    mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input)))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const titles = () => Array.from(document.querySelectorAll('[data-publication-row]')).map(
      (item) => item.querySelector('a')?.textContent,
    )

    // Default: title ascending -- "Paper without DOI" sorts before "Urban Data in VR".
    expect(titles()).toEqual(['Paper without DOI', 'Urban Data in VR'])

    expect(document.querySelector('.publication-list__header')).not.toBeInTheDocument()

    // The order comes back from the server now, so each change is a request.
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'title:desc' } })
    await waitFor(() => {
      expect(titles()).toEqual(['Urban Data in VR', 'Paper without DOI'])
    })

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'year:asc' } })
    // Ascending by year: missing years sort first (publication-2 has none).
    await waitFor(() => {
      expect(titles()).toEqual(['Paper without DOI', 'Urban Data in VR'])
    })

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'year:desc' } })
    await waitFor(() => {
      expect(titles()).toEqual(['Urban Data in VR', 'Paper without DOI'])
    })
  })

  it('asks the server for each sort key the list offers', async () => {
    const fetchMock = mockFetch((input) => pdfRetrievalDefault(String(input)) ?? servePublications(String(input)))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    for (const key of ['authors', 'year', 'source', 'stage', 'pdf'] as const) {
      fireEvent.change(screen.getByLabelText('Sort by'), {
        target: { value: `${key}:${key === 'year' || key === 'pdf' ? 'desc' : 'asc'}` },
      })
      await waitFor(() => {
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes(`sort=${key}`))).toBe(true)
      })
    }
  })
})
