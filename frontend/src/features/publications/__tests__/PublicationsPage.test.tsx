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
    extractionStatus: null,
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
    expect(screen.getByRole('button', { name: 'Add a Publication' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2 papers missing a PDF' })).toBeInTheDocument()

    const publicationCard = screen.getByText('Urban Data in VR').closest('li') as HTMLElement
    const abstract = within(publicationCard).getByText('Abstract').closest('details') as HTMLDetailsElement
    expect(abstract).not.toHaveAttribute('open')
    expect(within(abstract).getByText('A compact abstract for the immersive analytics study.')).toBeInTheDocument()
    fireEvent.click(within(abstract).getByText('Abstract'))
    expect(abstract).toHaveAttribute('open')

    const noAbstractCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    expect(within(noAbstractCard).getByText('No abstract available.')).toBeInTheDocument()
  })

  it('shows management controls to regular project members, not just owners', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByLabelText('Select Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Edit' }).length).toBeGreaterThan(0)
    expect(screen.getByText('Metadata Enrichment')).toBeInTheDocument()
  })

  it('hides the multi-select checkbox and management controls when publication management is unavailable', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false, canManagePublications: false })
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.queryByLabelText('Select Urban Data in VR')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Urban Data in VR' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByText('Metadata Enrichment')).not.toBeInTheDocument()
  })

  it('hides reviewer-decision override actions from regular project members', async () => {
    const reviewDetails = {
      screening: {
        titleAbstract: {
          finalDecision: null,
          criteria: [],
          reviewerDecisions: [
            {
              workItemId: 'screening-1', reviewerName: 'Reviewer One', outcome: 'include',
              criteriaAnswers: {}, notes: null, version: 1,
            },
          ],
        },
        fullText: null,
      },
      extraction: null,
    }
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      if (url.endsWith('/review-details')) return jsonResponse(reviewDetails)
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const card = await screen.findByText('Urban Data in VR').then((element) => element.closest('li') as HTMLElement)
    fireEvent.click(within(card).getByText('Review details'))

    expect(await within(card).findByText('Reviewer One')).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Override Title/Abstract' })).not.toBeInTheDocument()
  })

  it('shows singular count for a single publication', async () => {
    mockFetch(() => jsonResponse([publications[0]]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('1 publication in this project')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1 paper missing a PDF' })).toBeInTheDocument()
  })

  it('shows when every publication has an attached PDF', async () => {
    mockFetch(() => jsonResponse([
      { ...publications[0], fullText: { available: true } },
    ]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByRole('button', { name: 'All papers have a PDF' })).toBeDisabled()
  })

  it('clicking a publication opens an edit form that saves metadata', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
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
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
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
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
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
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
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
        publication: publications[0],
      },
    ]
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
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
    expect(within(panel).getAllByText('Urban Data in VR').length).toBeGreaterThan(0)
    expect(within(panel).getByText('Urban Data in Virtual Reality')).toBeInTheDocument()
    fireEvent.click(within(panel).getByText('All publication metadata'))
    expect(within(panel).getByText('A. Author')).toBeInTheDocument()

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
    expect(within(includedCard).getByText(/Data extraction: Completed/)).toBeInTheDocument()

    const pendingCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    expect(within(pendingCard).getByText(/Title\/Abstract: Pending/)).toBeInTheDocument()
    expect(within(pendingCard).queryByText(/Full text:/)).not.toBeInTheDocument()
    expect(within(pendingCard).queryByText(/Data extraction:/)).not.toBeInTheDocument()

    expect(screen.getByText('2 publications in this project')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Title/Abstract stage'), { target: { value: 'include' } })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.queryByText('Paper without DOI')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 publications match your filters')).toBeInTheDocument()
  })

  it('shows the retrieval failure reason instead of "Pending" when full text could not be retrieved', async () => {
    const unretrievable = {
      ...publications[0],
      id: 'publication-3',
      title: 'Unreachable Paper',
      fullText: { available: false, retrievalStatus: 'not_found' },
      screeningStatus: { titleAbstract: 'include', fullText: null },
    }
    mockFetch(() => jsonResponse([unretrievable]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const card = await screen.findByText('Unreachable Paper').then((el) => el.closest('li') as HTMLElement)
    expect(within(card).getByText(/Full text: Not found/)).toBeInTheDocument()
    expect(within(card).queryByText(/Full text: Pending/)).not.toBeInTheDocument()
  })

  it('shows review details and lets the owner override screening and extraction', async () => {
    let reviewDetails = {
      screening: {
        titleAbstract: {
          finalDecision: {
            outcome: 'include', resolutionMethod: 'agreement', note: null, resolvedBy: null,
          },
          criteria: [
            { id: 'ic-1', kind: 'inclusion' as const, text: 'Relevant population' },
            { id: 'ec-1', kind: 'exclusion' as const, text: 'Editorial or commentary' },
          ],
          reviewerDecisions: [
            {
              workItemId: 'screening-1', reviewerName: 'Reviewer One', outcome: 'include',
              criteriaAnswers: { 'ic-1': true, 'ec-1': false }, notes: 'Relevant population',
              version: 1,
            },
          ],
        },
        fullText: {
          finalDecision: {
            outcome: 'exclude', resolutionMethod: 'admin_consensus', note: 'Wrong design', resolvedBy: 'Owner',
          },
          criteria: [],
          reviewerDecisions: [],
        },
      },
      extraction: {
        workItemId: 'extraction-1',
        status: 'completed',
        completedAt: '2026-08-01T12:00:00Z',
        response: {
          id: 'response-1',
          version: 1,
          reviewerName: 'Extractor One',
          answers: { finding: 'Original finding', participants: 12 },
          fields: [
            {
              stableKey: 'finding', label: 'Main finding', fieldType: 'long_text',
              required: true, options: [],
            },
            {
              stableKey: 'participants', label: 'Participants', fieldType: 'number',
              required: false, options: [],
            },
          ],
        },
      },
    }
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      if (url.endsWith('/review-details')) return jsonResponse(reviewDetails)
      if (url.endsWith('/screening/work-items/screening-1/override') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        reviewDetails = {
          ...reviewDetails,
          screening: {
            ...reviewDetails.screening,
            titleAbstract: {
              ...reviewDetails.screening.titleAbstract,
              reviewerDecisions: [{
                ...reviewDetails.screening.titleAbstract.reviewerDecisions[0],
                reviewerName: 'Owner',
                outcome: body.outcome,
                criteriaAnswers: body.criteriaAnswers,
                notes: body.notes,
                version: 2,
              }],
            },
          },
        }
        return jsonResponse({
          id: 'decision-2', version: 2, outcome: body.outcome,
          criteriaAnswers: body.criteriaAnswers, notes: body.notes,
        })
      }
      if (url.endsWith('/extraction/extraction-1/override') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        reviewDetails = {
          ...reviewDetails,
          extraction: {
            ...reviewDetails.extraction,
            response: {
              ...reviewDetails.extraction.response,
              version: 2,
              answers: body.answers,
            },
          },
        }
        return jsonResponse({ id: 'response-2', version: 2, answers: body.answers })
      }
      return jsonResponse(publications)
    })
    renderWithProviders(<PublicationsPage />, {
      route: '/projects/p1/publications', path: '/projects/:projectId/publications',
    })

    const card = await screen.findByText('Urban Data in VR').then((element) => element.closest('li') as HTMLElement)
    fireEvent.click(within(card).getByText('Review details'))

    expect(await within(card).findByText('Reviewer One')).toBeInTheDocument()
    expect(within(card).getByText('IC1')).toBeInTheDocument()
    expect(within(card).getAllByText('Relevant population')).toHaveLength(2)
    expect(within(card).getByRole('cell', { name: 'IC1: Fulfilled' })).toHaveTextContent('Yes')
    expect(within(card).getByRole('cell', { name: 'IC1: Fulfilled' }).querySelector('svg')).toBeNull()
    expect(within(card).getByText('EC1')).toBeInTheDocument()
    expect(within(card).getByText('Editorial or commentary')).toBeInTheDocument()
    expect(within(card).getByRole('cell', { name: 'EC1: Not fulfilled' })).toHaveTextContent('Yes')
    expect(within(card).queryByText(/LLM suggestion/i)).not.toBeInTheDocument()
    expect(within(card).getByText('Original finding')).toBeInTheDocument()
    expect(within(card).getByText(/Version 1 by Extractor One/)).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Override Title/Abstract' }))
    fireEvent.click(within(card).getByLabelText('IC1: Set not fulfilled'))
    fireEvent.change(within(card).getByLabelText('Reason for override'), {
      target: { value: 'The criterion was applied incorrectly' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Save override' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/screening/work-items/screening-1/override')
        && init?.method === 'POST'
      ))
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        outcome: 'include',
        criteriaAnswers: { 'ic-1': false, 'ec-1': false },
        notes: 'Relevant population',
        reason: 'The criterion was applied incorrectly',
      })
    })

    fireEvent.click(within(card).getByRole('button', { name: 'Override data extraction' }))
    fireEvent.change(within(card).getByLabelText('Main finding *'), {
      target: { value: 'Owner-corrected finding' },
    })
    fireEvent.change(within(card).getByLabelText('Reason for override'), {
      target: { value: 'Corrected from source PDF' },
    })
    fireEvent.click(within(card).getByRole('button', { name: 'Save extraction override' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/extraction/extraction-1/override') && init?.method === 'POST'
      ))
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        answers: { finding: 'Owner-corrected finding', participants: 12 },
        reason: 'Corrected from source PDF',
      })
    })
  })

  it('searches across publication metadata', async () => {
    mockFetch(() => jsonResponse(publications))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    await screen.findByText('Urban Data in VR')
    fireEvent.change(screen.getByLabelText('Search publications'), { target: { value: '10.1000/urban-vr' } })

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

    const pdfStatus = screen.getByLabelText('PDF status')
    const missingPdfButton = screen.getByRole('button', { name: '1 paper missing a PDF' })
    expect(pdfStatus.closest('label')?.nextElementSibling).toBe(missingPdfButton)

    fireEvent.click(missingPdfButton)
    expect(pdfStatus).toHaveValue('unavailable')
    expect(missingPdfButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Urban Data in VR')).not.toBeInTheDocument()
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()

    fireEvent.click(missingPdfButton)
    expect(pdfStatus).toHaveValue('')
    expect(missingPdfButton).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()

    fireEvent.change(pdfStatus, { target: { value: 'available' } })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.queryByText('Paper without DOI')).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 publications match your filters')).toBeInTheDocument()

    fireEvent.change(pdfStatus, { target: { value: 'unavailable' } })
    expect(screen.queryByText('Urban Data in VR')).not.toBeInTheDocument()
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()

    fireEvent.change(pdfStatus, { target: { value: '' } })
    expect(screen.getByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByText('Paper without DOI')).toBeInTheDocument()
  })

  it('bulk-deletes the selected publications after confirming', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
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
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
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

  it('shows per-publication export links, gating PDF export on availability', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (url.endsWith('/metadata-conflicts')) return jsonResponse([])
      return jsonResponse([
        { ...publications[0], fullText: { available: true } },
        publications[1],
      ])
    })
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    const withPdfCard = await screen.findByText('Urban Data in VR').then((el) => el.closest('li') as HTMLElement)
    expect(within(withPdfCard).getByRole('link', { name: /Export BibTeX/ })).toHaveAttribute(
      'href', '/api/v1/projects/p1/publications/publication-1/export/bib',
    )
    expect(within(withPdfCard).getByRole('link', { name: /Export PDF/ })).toHaveAttribute(
      'href', '/api/v1/projects/p1/publications/publication-1/export/pdf',
    )

    const withoutPdfCard = screen.getByText('Paper without DOI').closest('li') as HTMLElement
    expect(within(withoutPdfCard).getByRole('link', { name: /Export BibTeX/ })).toBeInTheDocument()
    expect(within(withoutPdfCard).queryByRole('link', { name: /Export PDF/ })).not.toBeInTheDocument()
  })

  it('bulk-exports selected publications as a PDF+BibTeX bundle and links the finished download', async () => {
    let jobStatus = 'queued'
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
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
      return jsonResponse(publications)
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
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
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
