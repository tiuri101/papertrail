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

const criteria = [
  { id: 'criterion-1', kind: 'inclusion', text: 'Uses virtual reality' },
]

const workItem = {
  id: 'work-1',
  publication: {
    id: 'publication-1',
    title: 'Urban Data in VR',
    authors: 'Doe, Jane',
    abstract: 'A study of urban data in virtual reality.',
    doi: '10.1/vr',
    publisherUrl: null,
  },
  criteria,
  draft: {},
}

function render({
  fulltextNext,
  progress = { total: 1, addressed: 0 },
  screeningNext = [null],
  putResponses = [{}],
}: {
  fulltextNext: (unknown | null)[]
  progress?: { total: number; addressed: number }
  screeningNext?: (unknown | null)[]
  putResponses?: unknown[]
}) {
  let fulltextNextCallCount = 0
  let screeningNextCallCount = 0
  let putCallCount = 0
  const fetchMock = mockFetch((input, init) => {
    const path = String(input)
    if (path.endsWith('/full-text/next') && init?.method === 'POST') {
      const response = fulltextNext[Math.min(fulltextNextCallCount, fulltextNext.length - 1)]
      fulltextNextCallCount += 1
      return jsonResponse(response)
    }
    if (path.endsWith('/full-text/progress')) {
      return jsonResponse(progress)
    }
    if (path.includes('/full-text/') && path.endsWith('/release')) {
      return jsonResponse({ status: 'released' })
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
      const response = screeningNext[Math.min(screeningNextCallCount, screeningNext.length - 1)]
      screeningNextCallCount += 1
      return jsonResponse(response)
    }
    return jsonResponse({})
  })
  renderWithProviders(<FullTextPage />, { route: '/projects/p1/full-text', path: '/projects/:projectId/full-text' })
  return fetchMock
}

describe('FullTextPage', () => {
  it('shows the next unresolved retrieval when there is no assigned screening work', async () => {
    const retrieval = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    render({ fulltextNext: [retrieval], progress: { total: 1, addressed: 0 } })

    expect(await screen.findByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.getByLabelText('Retrieval status for Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByText('0 of 1 retrieval decisions made')).toBeInTheDocument()
    expect(screen.queryByText('Criteria')).not.toBeInTheDocument()
  })

  it('shows a message when no publications require full-text retrieval', async () => {
    render({ fulltextNext: [null], progress: { total: 0, addressed: 0 } })
    expect(await screen.findByText('No publications require full-text retrieval.')).toBeInTheDocument()
  })

  it('shows a message when nothing is left for this reviewer to do', async () => {
    render({ fulltextNext: [null], progress: { total: 2, addressed: 2 } })

    expect(await screen.findByText('No full-text work is currently available for you.')).toBeInTheDocument()
    expect(screen.getByText('2 of 2 retrieval decisions made')).toBeInTheDocument()
  })

  it('prioritizes an already-claimed screening item over a pending retrieval action', async () => {
    const retrieval = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    render({ fulltextNext: [retrieval], progress: { total: 1, addressed: 0 }, screeningNext: [workItem] })

    expect(await screen.findByRole('button', { name: 'Submit Decision' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Retrieval status for Urban Data in VR')).not.toBeInTheDocument()
  })

  it('hands an available report to screening instead of deciding during retrieval', async () => {
    const retrieval = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    render({ fulltextNext: [retrieval], progress: { total: 1, addressed: 0 } })

    await screen.findByLabelText('Retrieval status for Urban Data in VR')
    expect(screen.queryByText('Criteria')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Retrieval status for Urban Data in VR'), { target: { value: 'available' } })

    expect(await screen.findByText(/Save the available status to open full-text screening/)).toBeInTheDocument()
    expect(screen.queryByText('Criteria')).not.toBeInTheDocument()
  })

  it('saves retrieval first, then opens the screening item with LLM assistance', async () => {
    const retrieval = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    const fetchMock = render({
      fulltextNext: [retrieval, null],
      progress: { total: 1, addressed: 0 },
      screeningNext: [null, workItem],
      putResponses: [{ status: 'available', note: null, decisionSubmitted: false }],
    })

    await screen.findByLabelText('Retrieval status for Urban Data in VR')
    fireEvent.change(screen.getByLabelText('Retrieval status for Urban Data in VR'), { target: { value: 'available' } })
    const submitButton = screen.getByRole('button', { name: 'Save and start screening' })
    expect(submitButton).not.toBeDisabled()
    fireEvent.click(submitButton)

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(putCall?.[0]).toBe('/api/v1/projects/p1/full-text/retrieval-1')
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        status: 'available',
        note: null,
        decision: null,
      })
    })

    expect(await screen.findByRole('button', { name: 'Submit Decision' })).toBeInTheDocument()
    const putCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')
    expect(putCalls).toHaveLength(1)
    const screeningNextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/screening/full_text/next') && init?.method === 'POST')
    expect(screeningNextCalls).toHaveLength(2)
  })

  it('falls back to the reviewer queue when nobody was assigned to screen the paper just marked available', async () => {
    const retrieval = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    const fetchMock = render({
      fulltextNext: [retrieval, null],
      progress: { total: 1, addressed: 0 },
      screeningNext: [null, workItem],
      putResponses: [{ status: 'available', note: null, decisionSubmitted: false }],
    })

    await screen.findByLabelText('Retrieval status for Urban Data in VR')
    fireEvent.change(screen.getByLabelText('Retrieval status for Urban Data in VR'), { target: { value: 'available' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save and start screening' }))

    expect(await screen.findByRole('button', { name: 'Submit Decision' })).toBeInTheDocument()
    await waitFor(() => {
      const screeningNextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/screening/full_text/next') && init?.method === 'POST')
      expect(screeningNextCalls).toHaveLength(2)
    })
  })

  it('saves a note alongside the current status without showing screening fields', async () => {
    const retrieval = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'requested', note: null }
    const fetchMock = render({
      fulltextNext: [retrieval, null],
      progress: { total: 1, addressed: 0 },
      putResponses: [{ status: 'requested', note: 'Requested via ILL', decisionSubmitted: false }],
    })

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
