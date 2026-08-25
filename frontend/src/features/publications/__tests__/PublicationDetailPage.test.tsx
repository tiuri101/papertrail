import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PublicationDetailPage } from '../PublicationDetailPage'
import { emptyResponse, jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const publication = {
  id: 'publication-1',
  title: 'Urban Data in VR',
  authors: 'A. Author',
  abstract: 'A compact abstract for the immersive analytics study.',
  publicationYear: 2025,
  venue: 'ACM CHI',
  publicationType: 'Conference paper',
  doi: '10.1000/urban-vr',
  publisherUrl: 'https://publisher.example/urban-vr',
  keywords: 'Virtual Reality, Urban Planning',
  isbn: null,
  issn: null,
  pubmedId: null,
  arxivId: null,
  fullText: { available: true, document: { pageCount: 12 } },
  screeningStatus: { titleAbstract: 'include', fullText: null },
  extractionStatus: null,
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input)
  if (url.endsWith('/auth/session')) {
    return jsonResponse({ user: { id: 'u1', username: 'owner', displayName: 'Owner', isAdmin: false, isActive: true }, csrfToken: 'csrf' })
  }
  if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
  if (url.endsWith('/publications')) return jsonResponse([publication])
  if (url.endsWith('/extraction/publications/publication-1/final')) return jsonResponse(null)
  if (url.endsWith('/review-details')) {
    return jsonResponse({ screening: { titleAbstract: null, fullText: null } })
  }
  if (url.endsWith('/audit')) return jsonResponse([])
  if (init?.method === 'DELETE') return emptyResponse(204)
  return undefined
}

function render() {
  return renderWithProviders(<PublicationDetailPage />, {
    route: '/projects/p1/publications/publication-1',
    path: '/projects/:projectId/publications/:publicationId',
  })
}

describe('PublicationDetailPage', () => {
  it('renders the header, stage/pdf badges, and overview tab', async () => {
    mockFetch((input, init) => defaultFetch(input, init) ?? jsonResponse(null))
    render()

    expect(await screen.findByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.getByText('A. Author')).toBeInTheDocument()
    expect(screen.getByText('2025, ACM CHI · Conference paper')).toBeInTheDocument()
    expect(screen.getAllByText('Full-Text').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'PDF (12 pages)' })).toHaveAttribute(
      'href', '/api/v1/projects/p1/publications/publication-1/full-text/content',
    )
    expect(screen.getByText(/A compact abstract for the immersive analytics study\./)).toBeInTheDocument()
    expect(screen.getByText('Virtual Reality')).toBeInTheDocument()
    expect(screen.getByText('Urban Planning')).toBeInTheDocument()
  })

  it('shows Has Data when a final extraction exists', async () => {
    mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/extraction/publications/publication-1/final')) {
        return jsonResponse({
          id: 'final-1', publicationId: 'publication-1', answers: { finding: 'x' }, note: null, createdAt: '2026-01-01T00:00:00Z',
        })
      }
      return defaultFetch(input, init) ?? jsonResponse(null)
    })
    render()

    expect(await screen.findByText('Has Data')).toBeInTheDocument()
  })

  it('switches between tabs', async () => {
    mockFetch((input, init) => defaultFetch(input, init) ?? jsonResponse(null))
    render()

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }))
    expect(screen.getByText('Publisher URL')).toBeInTheDocument()
    expect(screen.getByText('10.1000/urban-vr')).toBeInTheDocument()
    expect(screen.getByText('PDF pages')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '10.1000/urban-vr' })).toHaveAttribute(
      'href', 'https://doi.org/10.1000/urban-vr',
    )
    expect(screen.getAllByText('-').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    expect(await screen.findByRole('region', { name: 'Full text document' })).toBeInTheDocument()
  })

  it('hides history from non-managers and shows it for managers', async () => {
    mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false, canManagePublications: true })
      if (url.endsWith('/audit')) {
        return jsonResponse([
          { id: 'e1', createdAt: '2026-01-01T00:00:00Z', actorUsername: 'owner', action: 'publication.updated', entityType: 'publication', entityId: 'publication-1', summary: 'Updated title', metadata: {} },
        ])
      }
      return defaultFetch(input, init) ?? jsonResponse(null)
    })
    render()

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(screen.getByText('Only the project owner or an administrator can view the activity log.')).toBeInTheDocument()
  })

  it('shows publication-scoped audit history for managers', async () => {
    mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/review-details')) {
        return jsonResponse({
          screening: {
            titleAbstract: {
              finalDecision: {
                outcome: 'include',
                resolutionMethod: 'agreement',
                note: null,
                resolvedBy: null,
                resolvedAt: '2026-01-03T00:00:00Z',
              },
              criteria: [],
              reviewerDecisions: [{
                workItemId: 'work-1',
                reviewerName: 'Reviewer One',
                outcome: 'include',
                criteriaAnswers: {},
                notes: null,
                version: 1,
                createdAt: '2026-01-02T12:00:00Z',
              }],
            },
            fullText: null,
          },
        })
      }
      if (url.endsWith('/audit')) {
        return jsonResponse([
          { id: 'e1', createdAt: '2026-01-01T00:00:00Z', actorUsername: 'owner', action: 'publication.updated', entityType: 'publication', entityId: 'publication-1', summary: 'Updated title', metadata: {} },
          { id: 'e2', createdAt: '2026-01-02T00:00:00Z', actorUsername: 'owner', action: 'project.created', entityType: 'project', entityId: 'p1', summary: 'Created project', metadata: {} },
        ])
      }
      return defaultFetch(input, init) ?? jsonResponse(null)
    })
    render()

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText('Updated title')).toBeInTheDocument()
    expect(screen.getByText('Title/Abstract decision: Included')).toBeInTheDocument()
    expect(screen.getByText('Final title/abstract decision: Included (agreement)')).toBeInTheDocument()
    expect(screen.queryByText('Created project')).not.toBeInTheDocument()
  })

  it('refreshes the activity log after metadata is edited', async () => {
    let metadataUpdated = false
    let auditRequests = 0
    mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/audit')) {
        auditRequests += 1
        return jsonResponse(metadataUpdated ? [{
          id: 'metadata-update',
          createdAt: '2026-01-04T00:00:00Z',
          actorUsername: 'owner',
          action: 'publication.updated',
          entityType: 'publication',
          entityId: 'publication-1',
          summary: 'Updated publication metadata',
          metadata: { fields: ['title'] },
        }] : [])
      }
      if (url.includes('/publications/publication-1') && init?.method === 'PATCH') {
        metadataUpdated = true
        return jsonResponse({ ...publication, title: 'Urban Data in Virtual Reality' })
      }
      return defaultFetch(input, init) ?? jsonResponse(null)
    })
    render()

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByText('No recorded history for this publication yet.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Edit Metadata/ }))
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'Urban Data in Virtual Reality' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Updated publication metadata')).toBeInTheDocument()
    expect(auditRequests).toBeGreaterThanOrEqual(2)
  })

  it('edits metadata from the Quick Actions panel', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.includes('/publications/publication-1') && init?.method === 'PATCH') {
        return jsonResponse({ ...publication, title: 'Urban Data in Virtual Reality' })
      }
      return defaultFetch(input, init) ?? jsonResponse(null)
    })
    render()

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('button', { name: /Edit Metadata/ }))

    const titleInput = await screen.findByLabelText('Title')
    expect(screen.getByRole('button', { name: '← Back to Publication' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Back to Publications/ })).not.toBeInTheDocument()

    fireEvent.change(titleInput, { target: { value: 'Urban Data in Virtual Reality' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, callInit]) => callInit?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(JSON.parse(String(patchCall?.[1]?.body)).title).toBe('Urban Data in Virtual Reality')
    })
    expect(await screen.findByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
  })

  it('shows "Back to Publication" and stays on the page when Edit Metadata is closed', async () => {
    mockFetch((input, init) => defaultFetch(input, init) ?? jsonResponse(null))
    render()

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('button', { name: /Edit Metadata/ }))
    await screen.findByLabelText('Title')

    fireEvent.click(screen.getByRole('button', { name: '← Back to Publication' }))
    expect(await screen.findByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
  })

  it('opens the metadata editor directly when linked with ?edit=1, with a link back to the list', async () => {
    mockFetch((input, init) => defaultFetch(input, init) ?? jsonResponse(null))
    renderWithProviders(<PublicationDetailPage />, {
      route: '/projects/p1/publications/publication-1?edit=1',
      path: '/projects/:projectId/publications/:publicationId',
    })

    expect(await screen.findByLabelText('Title')).toHaveValue('Urban Data in VR')
    expect(screen.getByRole('link', { name: '← Back to Publications' })).toHaveAttribute(
      'href', '/projects/p1/publications',
    )
    expect(screen.queryByRole('button', { name: /Back to Publication/ })).not.toBeInTheDocument()
  })

  it('deletes the publication after confirming', async () => {
    const fetchMock = mockFetch((input, init) => defaultFetch(input, init) ?? jsonResponse(null))
    render()

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('button', { name: /Delete Publication/ }))
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be undone/)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, callInit]) => callInit?.method === 'DELETE')).toBe(true)
    })
  })

  it('shows review details and lets a manager override screening and extraction', async () => {
    let reviewDetails = {
      screening: {
        titleAbstract: {
          finalDecision: {
            outcome: 'include', resolutionMethod: 'agreement', note: null, resolvedBy: null,
            resolvedAt: '2026-08-02T09:00:00Z',
          },
          criteria: [
            { id: 'ic-1', kind: 'inclusion' as const, text: 'Relevant population' },
          ],
          reviewerDecisions: [
            {
              workItemId: 'screening-1', reviewerName: 'Reviewer One', outcome: 'include',
              criteriaAnswers: { 'ic-1': true }, notes: 'Relevant population', version: 1,
              createdAt: '2026-08-01T09:00:00Z',
            },
          ],
        },
        fullText: null,
      },
      extraction: {
        requiredReviewers: 1,
        slots: [
          {
            slotNumber: 1,
            workItemId: 'extraction-1',
            status: 'completed',
            completedAt: '2026-08-01T12:00:00Z',
            response: {
              id: 'response-1',
              version: 1,
              reviewerName: 'Extractor One',
              answers: { finding: 'Original finding' },
              fields: [
                { stableKey: 'finding', label: 'Main finding', fieldType: 'long_text', required: true, options: [] },
              ],
            },
          },
        ],
        final: {
          answers: { finding: 'Original finding' },
          resolutionMethod: 'single_reviewer',
          resolvedAt: '2026-08-01T12:00:00Z',
        },
      },
      quality: {
        status: 'completed',
        completedAt: '2026-08-03T09:00:00Z',
        response: {
          reviewerName: 'Assessor One',
          answers: { design: 'strong', blinded: false },
          totalScore: 4,
          version: 1,
          fields: [
            { stableKey: 'design', label: 'Study design', fieldType: 'single_select', required: true, options: ['strong', 'weak'] },
            { stableKey: 'blinded', label: 'Blinded', fieldType: 'checkbox', required: false, options: [] },
          ],
        },
      },
    }
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
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
                outcome: body.outcome,
                criteriaAnswers: body.criteriaAnswers,
                notes: body.notes,
                version: 2,
              }],
            },
          },
        }
        return jsonResponse({ id: 'decision-2', version: 2 })
      }
      return defaultFetch(input, init) ?? jsonResponse(null)
    })
    render()

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect((await screen.findAllByText(/Reviewer One/)).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/Decided/)).toHaveTextContent(new Date('2026-08-01T09:00:00Z').toLocaleString())
    expect(screen.getByText(/Final via agreement/)).toHaveTextContent(new Date('2026-08-02T09:00:00Z').toLocaleString())
    expect(screen.getByText('Original finding')).toBeInTheDocument()
    expect(screen.getByText('Quality assessment')).toBeInTheDocument()
    expect(screen.getByText(/Assessed by Assessor One/)).toBeInTheDocument()
    expect(screen.getByText('strong')).toBeInTheDocument()
    // The unchecked "Blinded" checkbox was recorded (and is shown) as an
    // explicit "No" rather than being missing from the section entirely.
    expect(screen.getByText('Blinded')).toBeInTheDocument()
    expect(screen.getByText('No')).toBeInTheDocument()

    const screeningOverride = screen.getByRole('button', { name: 'Override Title/Abstract' })
    expect(screen.getByRole('button', { name: 'Override data extraction' })).toBeInTheDocument()

    fireEvent.click(screeningOverride)
    fireEvent.change(screen.getByLabelText('Reason for override'), {
      target: { value: 'The criterion was applied incorrectly' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([callInput, callInit]) => (
        String(callInput).endsWith('/screening/work-items/screening-1/override') && callInit?.method === 'POST'
      ))
      expect(call).toBeTruthy()
    })
  })

  it('shows a not-found message for an unknown publication id', async () => {
    mockFetch((input, init) => defaultFetch(input, init) ?? jsonResponse(null))
    renderWithProviders(<PublicationDetailPage />, {
      route: '/projects/p1/publications/missing-id',
      path: '/projects/:projectId/publications/:publicationId',
    })

    expect(await screen.findByRole('heading', { name: 'Publication not found' })).toBeInTheDocument()
  })
})
