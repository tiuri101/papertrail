import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DuplicateReviewPage } from '../DuplicateReviewPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const candidate = {
  id: 'candidate-1',
  publicationA: {
    id: 'publication-a',
    title: 'A Study of Urban VR',
    authors: 'Doe, Jane',
    publicationYear: 2025,
    venue: 'CHI',
    doi: '10.1000/same',
  },
  publicationB: {
    id: 'publication-b',
    title: 'A study of urban VR',
    authors: 'Doe, J.',
    publicationYear: 2025,
    venue: 'CHI Extended Abstracts',
    doi: '10.1000/same',
  },
  matchReasons: ['exact_doi', 'similar_title_authors', 'shared_issn'],
  confidence: 0.98,
  status: 'unresolved',
  autoResolved: false,
}

describe('DuplicateReviewPage', () => {
  it('lets a project owner queue duplicate detection again', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) {
        return jsonResponse({ id: 'p1', canManage: true, stage: 'duplicate_review' })
      }
      if (path.endsWith('/duplicates/detect') && init?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', status: 'queued' }, 202)
      }
      return jsonResponse([])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })

    fireEvent.click(await screen.findByRole('button', { name: 'Re-run Duplicate Detection' }))

    expect(await screen.findByText('Duplicate detection queued.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).endsWith('/duplicates/detect') && init?.method === 'POST'
    ))).toBe(true)
  })

  it('refreshes the candidates when the re-run detection job completes', async () => {
    let jobCompleted = false
    let duplicateFetchCount = 0
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) {
        return jsonResponse({ id: 'p1', canManage: true, stage: 'duplicate_review' })
      }
      if (path.endsWith('/duplicates/detect') && init?.method === 'POST') {
        return jsonResponse({ jobId: 'job-1', status: 'queued' }, 202)
      }
      if (path.endsWith('/jobs')) {
        return jsonResponse([{
          id: 'job-1',
          jobType: 'detect_duplicates',
          status: jobCompleted ? 'completed' : 'running',
          progressCurrent: jobCompleted ? 1 : 0,
          progressTotal: 1,
          progressMessage: null,
          errorMessage: null,
          createdAt: '2026-08-20T10:00:00Z',
          completedAt: jobCompleted ? '2026-08-20T10:00:01Z' : null,
        }])
      }
      if (path.endsWith('/duplicates')) duplicateFetchCount += 1
      return jsonResponse([])
    })
    const { queryClient } = renderWithProviders(<DuplicateReviewPage />, {
      route: '/projects/p1/duplicates',
      path: '/projects/:projectId/duplicates',
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Re-run Duplicate Detection' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => (
      String(input).endsWith('/jobs')
    ))).toBe(true))
    const fetchesBeforeCompletion = duplicateFetchCount

    jobCompleted = true
    await queryClient.invalidateQueries({ queryKey: ['jobs', 'p1'] })

    await waitFor(() => expect(duplicateFetchCount).toBeGreaterThan(fetchesBeforeCompletion))
    expect(screen.getByRole('status')).toHaveTextContent(
      'Duplicate detection finished. Results refreshed.',
    )
  })

  it('shows publication metadata and resolves a candidate as distinct', async () => {
    let resolved = false
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (init?.method === 'POST') {
        resolved = true
        return jsonResponse({ ...candidate, status: 'not_duplicate' })
      }
      return jsonResponse([{ ...candidate, status: resolved ? 'not_duplicate' : 'unresolved' }])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })

    expect(await screen.findByText('A Study of Urban VR')).toBeInTheDocument()
    expect(screen.getByText('A study of urban VR')).toBeInTheDocument()
    expect(screen.getByText('Doe, Jane')).toBeInTheDocument()
    expect(screen.getAllByText('2025')).toHaveLength(2)
    expect(screen.getByText('CHI')).toBeInTheDocument()
    expect(screen.getByText('CHI Extended Abstracts')).toBeInTheDocument()
    const doiLinks = screen.getAllByRole('link', { name: 'DOI' })
    expect(doiLinks).toHaveLength(2)
    expect(doiLinks[0]).toHaveAttribute('href', 'https://doi.org/10.1000/same')
    expect(doiLinks[0]).toHaveAttribute('target', '_blank')
    expect(screen.getByText('98% match')).toBeInTheDocument()
    const summary = screen.getByText('98% match').closest('li')!
    expect(summary).toHaveTextContent('Exact DOI')
    expect(summary).toHaveTextContent('Similar title & authors')
    expect(summary).toHaveTextContent('Shared ISSN')
    expect(summary).toHaveTextContent('unresolved')
    const candidateList = screen.getByRole('list', { name: 'Duplicate candidates' })
    expect(candidateList).toContainElement(summary)
    expect(screen.getByText('A Study of Urban VR').closest('li')).toBe(
      screen.getByText('A study of urban VR').closest('li'),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Not a Duplicate' }))

    await waitFor(() => expect(screen.getByText(/not_duplicate/)).toBeInTheDocument())
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(postCall?.[0]).toBe('/api/v1/projects/p1/duplicates/candidate-1/not-duplicate')
  })

  it('lets a regular project member (not a manager) resolve a candidate', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false })
      if (init?.method === 'POST') return jsonResponse({ ...candidate, status: 'not_duplicate' })
      return jsonResponse([candidate])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })

    expect(await screen.findByText('A Study of Urban VR')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Re-run Duplicate Detection' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Not a Duplicate' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
  })

  it('sends the selected canonical publication when merging', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      return init?.method === 'POST'
        ? jsonResponse({ ...candidate, status: 'merged' })
        : jsonResponse([candidate])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })
    await screen.findByText('A Study of Urban VR')

    const keepButtons = screen.getAllByRole('button', { name: 'Keep This One' })
    expect(keepButtons).toHaveLength(2)
    fireEvent.click(keepButtons[1])

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ canonicalPublicationId: 'publication-b' })
  })

  it('flags an automatically merged exact match instead of offering decision buttons', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      return jsonResponse([{ ...candidate, status: 'merged', autoResolved: true }])
    })
    renderWithProviders(<DuplicateReviewPage />, { route: '/projects/p1/duplicates', path: '/projects/:projectId/duplicates' })

    expect(await screen.findByText('Auto-merged')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Not a Duplicate' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Keep This One' })).not.toBeInTheDocument()
  })
})
