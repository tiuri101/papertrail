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

const criteria = [
  { id: 'criterion-1', kind: 'inclusion', text: 'Uses virtual reality' },
]

const workItem = {
  id: 'work-1',
  publication: {
    title: 'Urban Data in VR',
    authors: 'Doe, Jane',
    abstract: 'A study of urban data in virtual reality.',
    doi: '10.1/vr',
    publisherUrl: null,
  },
  criteria,
  draft: {},
}

function render(
  retrievals: unknown[],
  nextResponses: (unknown | null)[],
  putResponses: unknown[] = [{}],
) {
  let nextCallCount = 0
  let putCallCount = 0
  const fetchMock = mockFetch((input, init) => {
    const path = String(input)
    if (path.endsWith('/full-text') && (!init || init.method === undefined)) {
      return jsonResponse(retrievals)
    }
    if (path.includes('/full-text/') && init?.method === 'PUT') {
      const response = putResponses[Math.min(putCallCount, putResponses.length - 1)]
      putCallCount += 1
      return jsonResponse(response)
    }
    if (/\/projects\/[^/]+$/.test(path) && (!init || init.method === undefined)) {
      return jsonResponse({ criteria })
    }
    if (path.endsWith('/screening/full_text/next') && init?.method === 'POST') {
      const response = nextResponses[Math.min(nextCallCount, nextResponses.length - 1)]
      nextCallCount += 1
      return jsonResponse(response)
    }
    return jsonResponse({})
  })
  renderWithProviders(<FullTextPage />, { route: '/projects/p1/full-text', path: '/projects/:projectId/full-text' })
  return fetchMock
}

describe('FullTextPage', () => {
  it('shows the next unresolved retrieval when there is no assigned screening work', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null },
    ]
    render(retrievals, [null])

    expect(await screen.findByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.getByLabelText('Retrieval status for Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByText('0 of 1 retrieval decisions made')).toBeInTheDocument()
    expect(screen.queryByText('Criteria')).not.toBeInTheDocument()
  })

  it('shows a message when no publications require full-text retrieval', async () => {
    render([], [null])
    expect(await screen.findByText('No publications require full-text retrieval.')).toBeInTheDocument()
  })

  it('shows a message when nothing is left for this reviewer to do', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_found', note: null },
      { id: 'retrieval-2', publicationId: 'publication-2', publication: publicationB, status: 'available', note: null },
    ]
    render(retrievals, [null])

    expect(await screen.findByText('No full-text work is currently available for you.')).toBeInTheDocument()
    expect(screen.getByText('2 of 2 retrieval decisions made')).toBeInTheDocument()
  })

  it('prioritizes an already-claimed screening item over a pending retrieval action', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null },
    ]
    render(retrievals, [workItem])

    expect(await screen.findByRole('button', { name: 'Submit Decision' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Retrieval status for Urban Data in VR')).not.toBeInTheDocument()
  })

  it('does not show screening fields until the report is marked available', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null },
    ]
    render(retrievals, [null])

    await screen.findByLabelText('Retrieval status for Urban Data in VR')
    expect(screen.queryByText('Criteria')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Retrieval status for Urban Data in VR'), { target: { value: 'available' } })

    expect(await screen.findByText('Criteria')).toBeInTheDocument()
    expect(screen.getByLabelText('Inclusion: Uses virtual reality — Fulfilled')).toBeInTheDocument()
  })

  it('submits the retrieval status and the screening decision together in a single request', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null },
    ]
    const fetchMock = render(retrievals, [null], [{ status: 'available', note: null, decisionSubmitted: true }])

    await screen.findByLabelText('Retrieval status for Urban Data in VR')
    fireEvent.change(screen.getByLabelText('Retrieval status for Urban Data in VR'), { target: { value: 'available' } })
    await screen.findByText('Criteria')

    const submitButton = screen.getByRole('button', { name: 'Submit' })
    expect(submitButton).not.toBeDisabled()
    fireEvent.click(submitButton)

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(putCall?.[0]).toBe('/api/v1/projects/p1/full-text/retrieval-1')
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        status: 'available',
        note: null,
        decision: { outcome: 'include', criteriaAnswers: { 'criterion-1': true }, notes: null },
      })
    })

    expect(screen.queryByRole('button', { name: 'Submit Decision' })).not.toBeInTheDocument()
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(putCalls).toHaveLength(1)
    const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/screening/full_text/next') && init?.method === 'POST')
    expect(nextCalls).toHaveLength(1)
  })

  it('falls back to the reviewer queue when nobody was assigned to screen the paper just marked available', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null },
    ]
    const fetchMock = render(
      retrievals,
      [null, workItem],
      [{ status: 'available', note: null, decisionSubmitted: false }],
    )

    await screen.findByLabelText('Retrieval status for Urban Data in VR')
    fireEvent.change(screen.getByLabelText('Retrieval status for Urban Data in VR'), { target: { value: 'available' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(await screen.findByRole('button', { name: 'Submit Decision' })).toBeInTheDocument()
    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/screening/full_text/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
  })

  it('saves a note alongside the current status without showing screening fields', async () => {
    const retrievals = [
      { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'requested', note: null },
    ]
    const fetchMock = render(retrievals, [null], [{ status: 'requested', note: 'Requested via ILL', decisionSubmitted: false }])

    const noteField = await screen.findByLabelText('Note for Urban Data in VR')
    fireEvent.change(noteField, { target: { value: 'Requested via ILL' } })
    expect(screen.queryByText('Criteria')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        status: 'requested',
        note: 'Requested via ILL',
        decision: null,
      })
    })
    expect(screen.queryByRole('button', { name: 'Submit Decision' })).not.toBeInTheDocument()
  })
})
