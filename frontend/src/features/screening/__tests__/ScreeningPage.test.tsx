import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScreeningPage } from '../ScreeningPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const workItem = {
  id: 'work-1',
  publication: {
    title: 'Immersive Urban Analytics',
    authors: 'A. Author; B. Reviewer',
    abstract: 'A study of urban data in virtual reality.',
    doi: '10.1000/example',
    publisherUrl: 'https://publisher.example/paper',
  },
  criteria: [
    { id: 'criterion-1', kind: 'inclusion', text: 'Uses virtual reality' },
    { id: 'criterion-2', kind: 'exclusion', text: 'Is an editorial' },
  ],
  draft: {},
}

function renderScreening(handler: Parameters<typeof mockFetch>[0], stage = 'title_abstract') {
  const fetchMock = mockFetch(handler)
  renderWithProviders(<ScreeningPage />, {
    route: `/projects/project-1/screening/${stage}`,
    path: '/projects/:projectId/screening/:stage',
  })
  return fetchMock
}

function projectResponse(stage = 'title_abstract') {
  return jsonResponse({
    exclusionReasons: [
      { id: 'reason-wrong-topic', stage, label: 'Wrong topic' },
      { id: 'reason-other-stage', stage: stage === 'title_abstract' ? 'full_text' : 'title_abstract', label: 'Other stage' },
    ],
  })
}

describe('ScreeningPage', () => {
  it('fetches the next publication automatically on load, without clicking a button', async () => {
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      return projectResponse()
    })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Get next publication' })).not.toBeInTheDocument()
  })

  it('defaults inclusion criteria to Fulfilled and exclusion criteria to Not fulfilled', async () => {
    renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      return projectResponse()
    })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()

    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Not fulfilled' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Not fulfilled' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Fulfilled' })).not.toBeChecked()

    expect(screen.getByRole('button', { name: 'Submit decision' })).toBeEnabled()
  })

  it('requires re-answering a criterion after its default is unchecked', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : projectResponse())
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    const submit = screen.getByRole('button', { name: 'Submit decision' })
    expect(submit).toBeEnabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' }))
    expect(submit).toBeDisabled()
    expect(screen.getByText('Answer every criterion before submitting.')).toBeInTheDocument()
  })

  it('checking one answer for a criterion unchecks the other', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : projectResponse())
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    const fulfilled = screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' })
    const notFulfilled = screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Not fulfilled' })
    expect(fulfilled).toBeChecked()

    fireEvent.click(notFulfilled)
    expect(notFulfilled).toBeChecked()
    expect(fulfilled).not.toBeChecked()
  })

  it('sorts the criteria table by kind, inclusion before exclusion, regardless of API order', async () => {
    const reordered = {
      ...workItem,
      criteria: [
        { id: 'criterion-2', kind: 'exclusion', text: 'Is an editorial' },
        { id: 'criterion-1', kind: 'inclusion', text: 'Uses virtual reality' },
      ],
    }
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(reordered) : projectResponse())
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    const rowHeaders = screen.getAllByRole('rowheader').map((cell) => cell.textContent)
    expect(rowHeaders).toEqual([
      'Inclusion: Uses virtual reality',
      'Exclusion: Is an editorial',
    ])
  })

  it('requires a stage-specific exclusion reason and submits the completed decision', async () => {
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') return jsonResponse({ id: 'decision-1' }, 201)
      return projectResponse()
    })

    await screen.findByText('A study of urban data in virtual reality.')
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'exclude' } })

    expect(screen.getByRole('button', { name: 'Submit decision' })).toBeDisabled()
    expect(screen.getByRole('option', { name: 'Wrong topic' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Other stage' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Exclusion reason'), { target: { value: 'reason-wrong-topic' } })
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Outside the review scope.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/decision'))).toBe(true))
    const decisionCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/decision'))
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({
      outcome: 'exclude',
      criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
      exclusionReasonId: 'reason-wrong-topic',
      notes: 'Outside the review scope.',
    })
  })

  it('restores saved criterion answers from the work-item draft, overriding the default', async () => {
    renderScreening(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ ...workItem, draft: { criteriaAnswers: { 'criterion-1': false } } })
      : projectResponse())

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Not fulfilled' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Fulfilled' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Not fulfilled' })).toBeChecked()
  })

  it('reports that the queue has no available work, with no button to retry', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(null) : projectResponse())
    expect(await screen.findByText('No publications are currently available.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Get next publication' })).not.toBeInTheDocument()
  })

  it('automatically fetches the next publication after submitting a decision, with no button in between', async () => {
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') return jsonResponse({ id: 'decision-1' }, 201)
      return projectResponse()
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Submit decision' }))

    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
    expect(screen.queryByRole('button', { name: 'Get next publication' })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
  })

  it('uses the full-text heading and full-text exclusion reasons', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : projectResponse('full_text'), 'full_text')
    expect(screen.getByRole('heading', { name: 'Full-text screening' })).toBeInTheDocument()
    await screen.findByText(workItem.publication.abstract)
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'exclude' } })
    expect(screen.getByRole('option', { name: 'Wrong topic' })).toBeInTheDocument()
  })
})
