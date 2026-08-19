import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { TitleAbstractScreeningPage } from '../TitleAbstractScreeningPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { lastScreeningKey, saveLastCompletedItem } from '../../../lib/lastCompletedItem'

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
  llmAssistanceEnabled: true,
}

function renderScreening(handler: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(handler)
  renderWithProviders(<TitleAbstractScreeningPage />, {
    route: '/projects/project-1/screening/title_abstract',
    path: '/projects/:projectId/screening/title_abstract',
  })
  return fetchMock
}

describe('TitleAbstractScreeningPage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('fetches the next publication automatically on load, without clicking a button', async () => {
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      return jsonResponse({})
    })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Get next publication' })).not.toBeInTheDocument()
  })

  it('temporarily skips papers and presents them again after the rest of the queue', async () => {
    const secondItem = {
      ...workItem,
      id: 'work-2',
      publication: { ...workItem.publication, title: 'Second Paper' },
    }
    const fetchMock = renderScreening(async (input, init) => {
      const url = String(input)
      if (url.includes('/next') && init?.method === 'POST') {
        const excluded = new URL(url, 'http://localhost').searchParams.getAll('excludedItemId')
        if (excluded.length === 0) return jsonResponse(workItem)
        if (excluded.length === 1) return jsonResponse(secondItem)
        return jsonResponse(null)
      }
      if (url.endsWith('/release') && init?.method === 'POST') return jsonResponse({ status: 'released' })
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(await screen.findByRole('heading', { name: 'Second Paper' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('excludedItemId=work-1'))).toBe(true)
    expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/release') && init?.method === 'POST')).toHaveLength(2)
  })

  it('defaults inclusion criteria to Fulfilled and exclusion criteria to Not fulfilled', async () => {
    renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      return jsonResponse({})
    })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()

    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Not fulfilled' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Not fulfilled' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Fulfilled' })).not.toBeChecked()

    expect(screen.getByRole('button', { name: 'Submit Decision' })).toBeEnabled()
  })

  it('places the hidden title/abstract LLM suggestion below the Notes field', async () => {
    renderScreening(async (input) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/llm-title-abstract')) {
        return jsonResponse({ state: 'hidden', hidden: true })
      }
      return jsonResponse({})
    })

    const notes = await screen.findByLabelText('Notes')
    const hiddenMessage = await screen.findByText(/Hidden until you submit your own screening decision/)
    expect(notes.compareDocumentPosition(hiddenMessage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('requires re-answering a criterion after its default is unchecked', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    const submit = screen.getByRole('button', { name: 'Submit Decision' })
    expect(submit).toBeEnabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' }))
    expect(submit).toBeDisabled()
    expect(screen.getByText('Answer every criterion before submitting.')).toBeInTheDocument()
  })

  it('checking one answer for a criterion unchecks the other', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
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
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(reordered) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    const rowHeaders = screen.getAllByRole('rowheader').map((cell) => cell.textContent)
    expect(rowHeaders).toEqual([
      'IC1 Uses virtual reality',
      'EC1 Is an editorial',
    ])
  })

  it('switches the decision to Exclude when an inclusion criterion is marked not fulfilled', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    expect(screen.getByRole('radio', { name: 'Include' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Not fulfilled' }))
    expect(screen.getByRole('radio', { name: 'Exclude' })).toBeChecked()
  })

  it('switches the decision to Exclude when an exclusion criterion is marked fulfilled', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    expect(screen.getByRole('radio', { name: 'Include' })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Fulfilled' }))
    expect(screen.getByRole('radio', { name: 'Exclude' })).toBeChecked()
  })

  it('submits an exclude decision at the title/abstract stage without requiring a reason', async () => {
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') return jsonResponse({ id: 'decision-1' }, 201)
      return jsonResponse({})
    })

    await screen.findByText('A study of urban data in virtual reality.')
    fireEvent.click(screen.getByRole('radio', { name: 'Exclude' }))

    expect(screen.queryByLabelText('Exclusion reason')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit Decision' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Outside the review scope.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/decision'))).toBe(true))
    const decisionCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/decision'))
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({
      outcome: 'exclude',
      criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
      notes: 'Outside the review scope.',
    })
    expect(screen.getByRole('button', { name: 'Confirm Decision' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Decision' }))
    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(
        ([input]) => String(input).endsWith('/next'),
      )
      expect(nextCalls).toHaveLength(2)
    })
  })

  it('restores saved criterion answers from the work-item draft, overriding the default', async () => {
    renderScreening(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ ...workItem, draft: { criteriaAnswers: { 'criterion-1': false } } })
      : jsonResponse({}))

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Not fulfilled' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Fulfilled' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Not fulfilled' })).toBeChecked()
  })

  it('reports that the reviewer has completed all assigned screening work, with a way back to the project', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(null) : jsonResponse({}))
    expect(await screen.findByText('You have completed all of your assigned screening work.')).toBeInTheDocument()
    expect(screen.queryByText('Loading the next publication…')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Get next publication' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to project' })).toBeInTheDocument()
  })

  it('reveals assistance after a decision and continues when the reviewer is ready', async () => {
    let submitted = false
    let decisionPosts = 0
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') {
        submitted = true
        decisionPosts += 1
        const body = JSON.parse(String(init.body))
        return jsonResponse({ id: 'decision-1', ...body }, 201)
      }
      if (path.endsWith('/llm-title-abstract')) {
        if (!submitted) return jsonResponse({ state: 'hidden', hidden: true })
        return jsonResponse({
          state: 'ready', hidden: false, stale: false,
          suggestedDecision: 'include', confidence: 'high',
          reasoningSummary: 'The paper meets the criteria.', criteria: [],
        })
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }))

    expect(await screen.findByText(/LLM suggestion:/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm Decision' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Decision' }))

    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
    expect(decisionPosts).toBe(1)
    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
  })

  it('submits and then confirms a decision using only the Enter hotkey', async () => {
    let submitted = false
    let decisionPosts = 0
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') {
        submitted = true
        decisionPosts += 1
        const body = JSON.parse(String(init.body))
        return jsonResponse({ id: 'decision-1', ...body }, 201)
      }
      if (path.endsWith('/llm-title-abstract')) {
        if (!submitted) return jsonResponse({ state: 'hidden', hidden: true })
        return jsonResponse({
          state: 'ready', hidden: false, stale: false,
          suggestedDecision: 'include', confidence: 'high',
          reasoningSummary: 'The paper meets the criteria.', criteria: [],
        })
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.keyDown(window, { key: 'Enter' })

    expect(await screen.findByRole('button', { name: 'Confirm Decision' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Enter' })

    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
    expect(decisionPosts).toBe(1)
  })

  it('lets the reviewer immediately revise a decision when the LLM disagrees', async () => {
    let submitted = false
    let decisionPosts = 0
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') {
        decisionPosts += 1
        submitted = true
        const body = JSON.parse(String(init.body))
        return jsonResponse({
          id: `decision-${decisionPosts}`,
          outcome: body.outcome,
          criteriaAnswers: body.criteriaAnswers,
          notes: body.notes,
          version: decisionPosts,
        }, 201)
      }
      if (path.endsWith('/llm-title-abstract')) {
        if (!submitted) return jsonResponse({ state: 'hidden', hidden: true })
        return jsonResponse({
          state: 'ready', hidden: false, stale: false,
          suggestedDecision: 'exclude', confidence: 'high',
          reasoningSummary: 'An inclusion criterion is not met.', criteria: [],
        })
      }
      if (path.endsWith('/progress')) return jsonResponse({ assigned: 1, completed: submitted ? 1 : 0 })
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }))

    expect(await screen.findByText(/LLM suggestion:/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Exclude' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Decision' }))

    await waitFor(() => expect(decisionPosts).toBe(2))
    const decisionCalls = fetchMock.mock.calls.filter(
      ([input, init]) => String(input).endsWith('/decision') && init?.method === 'POST',
    )
    expect(JSON.parse(String(decisionCalls[1]?.[1]?.body))).toEqual({
      outcome: 'exclude',
      criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
      notes: null,
    })
  })

  it('shows how many papers are assigned to the reviewer and how many are screened', async () => {
    renderScreening(async (input) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/progress')) return jsonResponse({ assigned: 5, completed: 2 })
      return jsonResponse({})
    })

    expect(await screen.findByText('2 of 5 assigned papers screened')).toBeInTheDocument()
  })

  it('refreshes the assigned/screened count after submitting a decision', async () => {
    let completed = 2
    renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/progress')) return jsonResponse({ assigned: 5, completed })
      if (path.endsWith('/decision') && init?.method === 'POST') {
        completed += 1
        return jsonResponse({ id: 'decision-1' }, 201)
      }
      return jsonResponse({})
    })

    await screen.findByText('2 of 5 assigned papers screened')
    fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }))

    await waitFor(() => {
      expect(screen.getByText('3 of 5 assigned papers screened')).toBeInTheDocument()
    })
  })

  it('shows papers remaining instead of assigned counts in claim mode', async () => {
    renderScreening(async (input) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/progress')) {
        return jsonResponse({ assigned: 1, completed: 0, remaining: 7, claimMode: true })
      }
      return jsonResponse({})
    })

    expect(await screen.findByText('7 papers remaining')).toBeInTheDocument()
    expect(screen.queryByText(/assigned papers screened/)).not.toBeInTheDocument()
  })

  it('releases the reserved work item when leaving the page without deciding', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      if (path.endsWith('/release') && init?.method === 'POST') return jsonResponse({ status: 'released' })
      return jsonResponse({})
    })
    const { unmount } = renderWithProviders(<TitleAbstractScreeningPage />, {
      route: '/projects/project-1/screening/title_abstract',
      path: '/projects/:projectId/screening/title_abstract',
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    unmount()

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) =>
        String(input) === '/api/v1/projects/project-1/screening/work-items/work-1/release'
        && init?.method === 'POST')).toBe(true)
    })
  })

  it('advances to the next title/abstract item after a single Submit click when LLM assistance is off', async () => {
    let decisionPosts = 0
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') {
        return jsonResponse({ ...workItem, llmAssistanceEnabled: false })
      }
      if (path.endsWith('/decision') && init?.method === 'POST') {
        decisionPosts += 1
        return jsonResponse({ id: 'decision-1' }, 201)
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }))

    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
    expect(decisionPosts).toBe(1)
  })

  it('autosaves draft content shortly after the reviewer edits it', async () => {
    const fetchMock = renderScreening(async (input) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      return jsonResponse({})
    })

    await screen.findByText('A study of urban data in virtual reality.')
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Still reading this one.' } })

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/work-items/work-1/draft'))).toBe(false)

    await waitFor(() => {
      const draftCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/work-items/work-1/draft'))
      expect(draftCall).toBeTruthy()
      expect(JSON.parse(String(draftCall?.[1]?.body))).toEqual({
        draft: {
          criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
          outcome: 'include',
          notes: 'Still reading this one.',
        },
      })
    }, { timeout: 2000 })
  })

  it('auto-focuses the first criterion so arrow-key navigation works without an initial Tab', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    expect(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' })).toHaveFocus()
  })

  it('moves between criteria with arrow keys and answers with Left/Right', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    const fulfilled1 = screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' })
    const notFulfilled1 = screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Not fulfilled' })
    expect(fulfilled1).toHaveFocus()
    expect(fulfilled1).toBeChecked()

    fireEvent.keyDown(fulfilled1, { key: 'ArrowRight' })
    expect(notFulfilled1).toBeChecked()
    expect(fulfilled1).not.toBeChecked()
    expect(notFulfilled1).toHaveFocus()

    const notFulfilled2 = screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Not fulfilled' })
    fireEvent.keyDown(notFulfilled1, { key: 'ArrowDown' })
    expect(notFulfilled2).toHaveFocus()

    fireEvent.keyDown(notFulfilled2, { key: 'ArrowUp' })
    expect(notFulfilled1).toHaveFocus()
  })

  it('does not move past the first or last criterion row', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    const fulfilled1 = screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' })
    fireEvent.keyDown(fulfilled1, { key: 'ArrowUp' })
    expect(fulfilled1).toHaveFocus()

    const fulfilled2 = screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Fulfilled' })
    fireEvent.keyDown(fulfilled1, { key: 'ArrowDown' })
    fireEvent.keyDown(fulfilled2, { key: 'ArrowDown' })
    expect(fulfilled2).toHaveFocus()
  })

  it('sets the decision using the default keyboard hotkeys', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    expect(screen.getByRole('radio', { name: 'Include' })).toBeChecked()
    fireEvent.keyDown(window, { key: 'e' })
    expect(screen.getByRole('radio', { name: 'Exclude' })).toBeChecked()
    fireEvent.keyDown(window, { key: 'u' })
    expect(screen.getByRole('radio', { name: 'Uncertain' })).toBeChecked()
  })

  it('ignores decision hotkeys while typing in the Notes field', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    fireEvent.keyDown(screen.getByLabelText('Notes'), { key: 'e' })
    expect(screen.getByRole('radio', { name: 'Include' })).toBeChecked()
  })

  it('submits the decision with the default Enter hotkey', async () => {
    let decisionPosts = 0
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') {
        return jsonResponse({ ...workItem, llmAssistanceEnabled: false })
      }
      if (path.endsWith('/decision') && init?.method === 'POST') {
        decisionPosts += 1
        return jsonResponse({ id: 'decision-1' }, 201)
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.keyDown(window, { key: 'Enter' })

    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
    expect(decisionPosts).toBe(1)
  })

  it('does not submit with the Enter hotkey while a required criterion is unanswered', async () => {
    const fetchMock = renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    fireEvent.click(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Fulfilled' }))
    expect(screen.getByRole('button', { name: 'Submit Decision' })).toBeDisabled()

    fireEvent.keyDown(window, { key: 'Enter' })

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/decision'))).toBe(false)
  })

  it('ignores the Enter hotkey while typing in the Notes field', async () => {
    const fetchMock = renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    fireEvent.keyDown(screen.getByLabelText('Notes'), { key: 'Enter' })

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/decision'))).toBe(false)
  })

  const previousWorkItem = {
    id: 'work-1',
    publication: workItem.publication,
    criteria: workItem.criteria,
    decision: {
      id: 'decision-1',
      outcome: 'include',
      criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
      notes: null,
      version: 1,
    },
  }

  async function renderPreviousItem() {
    saveLastCompletedItem(lastScreeningKey('project-1', 'title_abstract'), { id: 'work-1', title: previousWorkItem.publication.title })
    let decisionPosts = 0
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(null)
      if (path.endsWith('/work-items/work-1') && !init?.method) return jsonResponse(previousWorkItem)
      if (path.endsWith('/work-items/work-1/decision') && init?.method === 'POST') {
        decisionPosts += 1
        return jsonResponse({ ...previousWorkItem.decision, version: 2 })
      }
      return jsonResponse({})
    })

    fireEvent.click(await screen.findByRole('button', { name: /Go back to/ }))
    await screen.findByText('You went back to the previous paper. Changes here update your existing decision.')
    return { fetchMock, decisionPosts: () => decisionPosts }
  }

  it('sets the decision using keyboard hotkeys when revisiting a previous decision', async () => {
    await renderPreviousItem()

    expect(screen.getByRole('radio', { name: 'Include' })).toBeChecked()
    fireEvent.keyDown(window, { key: 'e' })
    expect(screen.getByRole('radio', { name: 'Exclude' })).toBeChecked()
  })

  it('saves the revised decision with the Enter hotkey when revisiting a previous decision', async () => {
    const { fetchMock } = await renderPreviousItem()

    fireEvent.keyDown(window, { key: 'Enter' })

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) =>
        String(input).endsWith('/work-items/work-1/decision') && init?.method === 'POST',
      )).toBe(true)
    })
  })

})
