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
  llmAssistanceEnabled: true,
}

function renderScreening(handler: Parameters<typeof mockFetch>[0], stage = 'title_abstract') {
  const fetchMock = mockFetch(handler)
  renderWithProviders(<ScreeningPage />, {
    route: `/projects/project-1/screening/${stage}`,
    path: '/projects/:projectId/screening/:stage',
  })
  return fetchMock
}

describe('ScreeningPage', () => {
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

    expect(screen.getByLabelText('Decision')).toHaveValue('include')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Inclusion: Uses virtual reality — Not fulfilled' }))
    expect(screen.getByLabelText('Decision')).toHaveValue('exclude')
  })

  it('switches the decision to Exclude when an exclusion criterion is marked fulfilled', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(workItem) : jsonResponse({}))
    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })

    expect(screen.getByLabelText('Decision')).toHaveValue('include')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Exclusion: Is an editorial — Fulfilled' }))
    expect(screen.getByLabelText('Decision')).toHaveValue('exclude')
  })

  it('submits an exclude decision at the title/abstract stage without requiring a reason', async () => {
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') return jsonResponse({ id: 'decision-1' }, 201)
      return jsonResponse({})
    })

    await screen.findByText('A study of urban data in virtual reality.')
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'exclude' } })

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

  it('reports that the full-text queue has no available work', async () => {
    renderScreening(async (input) => String(input).endsWith('/next') ? jsonResponse(null) : jsonResponse({}), 'full_text')
    expect(await screen.findByText('You have completed all of your assigned screening work.')).toBeInTheDocument()
    expect(screen.queryByText('Loading the next publication…')).not.toBeInTheDocument()
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
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'exclude' } })
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
    const { unmount } = renderWithProviders(<ScreeningPage />, {
      route: '/projects/project-1/screening/title_abstract',
      path: '/projects/:projectId/screening/:stage',
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    unmount()

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) =>
        String(input) === '/api/v1/projects/project-1/screening/work-items/work-1/release'
        && init?.method === 'POST')).toBe(true)
    })
  })

  it('submits an exclude decision at the full-text stage without requiring a reason', async () => {
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next')) return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') return jsonResponse({ id: 'decision-1' }, 201)
      return jsonResponse({})
    }, 'full_text')

    expect(screen.getByRole('heading', { name: 'Full-Text Screening' })).toBeInTheDocument()
    await screen.findByText(workItem.publication.abstract)
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'exclude' } })

    expect(screen.getByRole('button', { name: 'Submit Decision' })).toBeEnabled()
    expect(screen.queryByLabelText('Exclusion reason')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Outside the review scope.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/decision'))).toBe(true))
    const decisionCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/decision'))
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toEqual({
      outcome: 'exclude',
      criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
      notes: 'Outside the review scope.',
    })
  })

  it('advances to the next full-text item after a single Submit click, without a confirmation step', async () => {
    let decisionPosts = 0
    const fetchMock = renderScreening(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/next') && init?.method === 'POST') return jsonResponse(workItem)
      if (path.endsWith('/decision') && init?.method === 'POST') {
        decisionPosts += 1
        return jsonResponse({ id: 'decision-1' }, 201)
      }
      if (path.endsWith('/llm-full-text')) {
        return jsonResponse({
          state: 'ready', hidden: false, stale: false,
          suggestedDecision: 'include', confidence: 'high',
          reasoningSummary: 'The paper meets the criteria.', criteria: [],
        })
      }
      return jsonResponse({})
    }, 'full_text')

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    expect(await screen.findByText(/LLM suggestion:/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Submit Decision' }))

    await waitFor(() => {
      const nextCalls = fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith('/next') && init?.method === 'POST')
      expect(nextCalls).toHaveLength(2)
    })
    expect(decisionPosts).toBe(1)
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
})
