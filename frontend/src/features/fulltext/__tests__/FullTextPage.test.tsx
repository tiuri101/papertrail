import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FullTextPage } from '../FullTextPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { lastScreeningKey, saveLastCompletedItem } from '../../../lib/lastCompletedItem'

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
  screeningProgress = { assigned: 0, completed: 0, remaining: 0, claimMode: false },
  screeningNext = [null],
  putResponses = [{}],
  releaseFails = false,
}: {
  fulltextNext: (unknown | null)[]
  progress?: { total: number; addressed: number }
  screeningProgress?: { assigned: number; completed: number; remaining: number; claimMode: boolean }
  screeningNext?: (unknown | null)[]
  putResponses?: unknown[]
  releaseFails?: boolean
}) {
  let fulltextNextCallCount = 0
  let screeningNextCallCount = 0
  let putCallCount = 0
  const fetchMock = mockFetch((input, init) => {
    const path = String(input)
    if (path.includes('/full-text/next') && init?.method === 'POST') {
      const response = fulltextNext[Math.min(fulltextNextCallCount, fulltextNext.length - 1)]
      fulltextNextCallCount += 1
      return jsonResponse(response)
    }
    if (path.endsWith('/full-text/progress')) {
      return jsonResponse(progress)
    }
    if (path.endsWith('/screening/full_text/progress')) {
      return jsonResponse(screeningProgress)
    }
    if (path.includes('/full-text/') && path.endsWith('/release')) {
      if (releaseFails) {
        return jsonResponse(
          { error: { code: 'conflict', message: 'This claim is no longer yours to release.' } },
          409,
        )
      }
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
    if (path.includes('/screening/full_text/next') && init?.method === 'POST') {
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
    expect(screen.getByText('Retrieval status recorded for 0 of 1 publications')).toBeInTheDocument()
    expect(screen.queryByText('Criteria')).not.toBeInTheDocument()
  })

  it('shows how many papers still need a full-text screening decision', async () => {
    const retrieval = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    render({
      fulltextNext: [retrieval],
      progress: { total: 1, addressed: 0 },
      screeningProgress: { assigned: 5, completed: 2, remaining: 3, claimMode: false },
    })

    expect(await screen.findByText('3 papers remaining for screening')).toBeInTheDocument()
  })

  it('temporarily skips a retrieval and advances to another paper', async () => {
    const first = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    const second = {
      id: 'retrieval-2',
      publicationId: 'publication-2',
      publication: { ...publicationA, id: 'publication-2', title: 'Second report' },
      status: 'not_yet_sought',
      note: null,
    }
    const fetchMock = render({ fulltextNext: [first, second], progress: { total: 2, addressed: 0 } })

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))

    expect(await screen.findByRole('heading', { name: 'Second report' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('excludedRetrievalId=retrieval-1'))).toBe(true)
  })

  // Regression: skipping used to hold the server-side claim until the
  // component tore down, so a skipped paper stayed invisibly locked to the
  // reviewer who passed on it and nobody else could pick it up.
  it('releases the server-side claim before claiming the next paper when skipping', async () => {
    const first = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    const second = {
      id: 'retrieval-2',
      publicationId: 'publication-2',
      publication: { ...publicationA, id: 'publication-2', title: 'Second report' },
      status: 'not_yet_sought',
      note: null,
    }
    const fetchMock = render({ fulltextNext: [first, second], progress: { total: 2, addressed: 0 } })

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    await screen.findByRole('heading', { name: 'Second report' })

    const paths = fetchMock.mock.calls.map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`)
    const releaseIndex = paths.findIndex((entry) => entry === 'POST /api/v1/projects/p1/full-text/retrieval-1/release')
    expect(releaseIndex).toBeGreaterThan(-1)
    // The claim is handed back before the reviewer is given anything else,
    // so they never hold two retrievals at once.
    const secondClaimIndex = paths.findIndex((entry) => entry.includes('excludedRetrievalId=retrieval-1'))
    expect(secondClaimIndex).toBeGreaterThan(releaseIndex)
    // Exactly one release: the item is not released again on teardown.
    expect(paths.filter((entry) => entry.endsWith('/retrieval-1/release'))).toHaveLength(1)
  })

  it('keeps the paper open and reports the failure when releasing a skipped claim fails', async () => {
    const first = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    const second = {
      id: 'retrieval-2',
      publicationId: 'publication-2',
      publication: { ...publicationA, id: 'publication-2', title: 'Second report' },
      status: 'not_yet_sought',
      note: null,
    }
    const fetchMock = render({
      fulltextNext: [first, second],
      progress: { total: 2, addressed: 0 },
      releaseFails: true,
    })

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('This claim is no longer yours to release.')
    // Still on the same paper -- no second claim was taken out behind a
    // release the server never acknowledged.
    expect(screen.getByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Second report' })).not.toBeInTheDocument()
    const claimCalls = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes('/full-text/next') && init?.method === 'POST'
    ))
    expect(claimCalls).toHaveLength(1)
  })

  it('shows a message when no publications require full-text retrieval', async () => {
    render({ fulltextNext: [null], progress: { total: 0, addressed: 0 } })
    expect(await screen.findByText('No publications require full-text retrieval.')).toBeInTheDocument()
  })

  it('shows a message when nothing is left for this reviewer to do', async () => {
    render({ fulltextNext: [null], progress: { total: 2, addressed: 2 } })

    expect(await screen.findByText('No full-text work is currently available for you.')).toBeInTheDocument()
    expect(screen.getByText('Retrieval status recorded for 2 of 2 publications')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to project' })).toBeInTheDocument()
  })

  it('prioritizes an already-claimed screening item over a pending retrieval action', async () => {
    const retrieval = { id: 'retrieval-1', publicationId: 'publication-1', publication: publicationA, status: 'not_yet_sought', note: null }
    render({ fulltextNext: [retrieval], progress: { total: 1, addressed: 0 }, screeningNext: [workItem] })

    expect(await screen.findByRole('button', { name: 'Submit Decision' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Retrieval status for Urban Data in VR')).not.toBeInTheDocument()
  })

  it('submits an exclude decision and advances to the next item without a confirmation step', async () => {
    const item = {
      ...workItem,
      criteria: [
        ...criteria,
        { id: 'criterion-2', kind: 'exclusion', text: 'Is an editorial' },
      ],
    }
    const fetchMock = render({
      fulltextNext: [null],
      progress: { total: 0, addressed: 0 },
      screeningNext: [item, null],
    })

    await screen.findByText(workItem.publication.abstract)
    fireEvent.click(screen.getByRole('radio', { name: 'Exclude' }))
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Outside the review scope.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/decision'))).toBe(true))
    const decisionCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/decision'))
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({
      outcome: 'exclude',
      criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
      notes: 'Outside the review scope.',
    })
    expect(screen.queryByRole('button', { name: 'Confirm Decision' })).not.toBeInTheDocument()
    await waitFor(() => {
      const screeningNextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/screening/full_text/next') && init?.method === 'POST')
      expect(screeningNextCalls).toHaveLength(2)
    })
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

  it('offers a "Go back" affordance for the last completed full-text screening decision', async () => {
    saveLastCompletedItem(lastScreeningKey('p1', 'full_text'), { id: 'work-1', title: 'Urban Data in VR' })
    const previousItem = {
      id: 'work-1',
      publication: workItem.publication,
      criteria,
      decision: {
        id: 'decision-1',
        outcome: 'include',
        criteriaAnswers: { 'criterion-1': true },
        notes: null,
        version: 1,
      },
    }
    const fetchMock = mockFetch((input, init) => {
      const path = String(input)
      if (path.includes('/full-text/next') && init?.method === 'POST') return jsonResponse(null)
      if (path.endsWith('/full-text/progress')) return jsonResponse({ total: 0, addressed: 0 })
      if (path.endsWith('/screening/full_text/progress')) {
        return jsonResponse({ assigned: 0, completed: 1, remaining: 0, claimMode: false })
      }
      if (path.includes('/screening/full_text/next') && init?.method === 'POST') return jsonResponse(null)
      if (path.endsWith('/screening/work-items/work-1') && !init?.method) return jsonResponse(previousItem)
      if (/\/projects\/[^/]+$/.test(path) && (!init || init.method === undefined)) return jsonResponse({ criteria })
      return jsonResponse({})
    })
    renderWithProviders(<FullTextPage />, { route: '/projects/p1/full-text', path: '/projects/:projectId/full-text' })

    const button = await screen.findByRole('button', { name: /Go back to/ })
    fireEvent.click(button)

    await screen.findByText('You went back to the previous paper. Changes here update your existing decision.')
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/screening/work-items/work-1'))).toBe(true)
  })
})
