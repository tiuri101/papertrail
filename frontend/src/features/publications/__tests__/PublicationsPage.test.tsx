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
    fullText: { available: false },
    screeningStatus: { titleAbstract: 'include', fullText: 'exclude' },
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
    fireEvent.click(screen.getByRole('button', { name: 'Metadata Enrichment' }))
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

  it('shows the screening stage status for each publication and filters by it', async () => {
    mockFetch(() => jsonResponse(publications))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const includedCard = await screen.findByText('Urban Data in VR').then((el) => el.closest('li') as HTMLElement)
    expect(within(includedCard).getByText(/Title\/Abstract: Included/)).toBeInTheDocument()
    expect(within(includedCard).getByText(/Full text: Excluded/)).toBeInTheDocument()

    const pendingCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    expect(within(pendingCard).getByText(/Title\/Abstract: Pending/)).toBeInTheDocument()
    expect(within(pendingCard).queryByText(/Full text:/)).not.toBeInTheDocument()

    expect(screen.getByText('2 publications in this project')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Title/Abstract stage'), { target: { value: 'include' } })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.queryByText('Paper without DOI')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 publications match your filters')).toBeInTheDocument()
  })

  it('filters publications by PDF status', async () => {
    mockFetch(() => jsonResponse([
      { ...publications[0], fullText: { available: true } },
      { ...publications[1], fullText: { available: false } },
    ]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('PDF status'), { target: { value: 'available' } })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.queryByText('Paper without DOI')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 publications match your filters')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('PDF status'), { target: { value: 'unavailable' } })
    expect(screen.queryByText('Urban Data in VR')).not.toBeInTheDocument()
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('PDF status'), { target: { value: '' } })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()
  })

  it('bulk-deletes the selected publications after confirming', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      if (url.endsWith('/publications/delete') && init?.method === 'POST') {
        return jsonResponse({ deletedCount: 1 })
      }
      return jsonResponse(publications)
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

  it('selects and deselects all filtered publications with Select All', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    fireEvent.click(screen.getByRole('button', { name: 'Metadata Enrichment' }))
    expect(screen.getByRole('button', { name: 'Enrich Selected (0)' })).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Select All (2)'))
    expect(screen.getByLabelText('Select Urban Data in VR')).toBeChecked()
    expect(screen.getByLabelText('Select Paper without DOI')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Enrich Selected (2)' })).not.toBeDisabled()

    fireEvent.click(screen.getByLabelText('Select All (2)'))
    expect(screen.getByLabelText('Select Urban Data in VR')).not.toBeChecked()
    expect(screen.getByLabelText('Select Paper without DOI')).not.toBeChecked()

    fireEvent.change(screen.getByLabelText('Title/Abstract stage'), { target: { value: 'include' } })
    fireEvent.click(screen.getByLabelText('Select All (1)'))
    expect(screen.getByLabelText('Select Urban Data in VR')).toBeChecked()
  })

  it('bulk-uploads and auto-matches PDFs against the whole project without any selection', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    fireEvent.click(screen.getByRole('button', { name: 'Bulk Attach PDFs' }))

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

  it('lets a manager attach a PDF from the publications page', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      if (url.endsWith('/publications/publication-1/full-text') && init?.method === 'POST') {
        return jsonResponse({ available: true, document: { id: 'doc-1', originalFilename: 'paper.pdf', fileSize: 1024, uploadedAt: '2026-08-08T10:00:00Z', uploadedBy: null, isActive: true, removedAt: null } }, 201)
      }
      if (url.endsWith('/publications/publication-1/full-text')) return jsonResponse({ available: false, document: null })
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    const card = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Attach PDF' }))

    expect(await within(card).findByText('No PDF attached')).toBeInTheDocument()
    const file = new File(['pdf'], 'paper.pdf', { type: 'application/pdf' })
    fireEvent.change(within(card).getByLabelText('Choose PDF'), { target: { files: [file] } })

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/publications/publication-1/full-text') && init?.method === 'POST')
      expect(post).toBeTruthy()
    })
    expect(await within(card).findByRole('link', { name: 'View PDF' })).toBeInTheDocument()
  })
})
