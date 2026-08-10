import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MyDecisionsPage } from '../MyDecisionsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const criteria = [
  { id: 'criterion-1', kind: 'inclusion', text: 'Uses virtual reality' },
  { id: 'criterion-2', kind: 'exclusion', text: 'Is an editorial' },
]

const baseItem = {
  workItemId: 'work-1',
  submittedAt: '2026-01-01T00:00:00Z',
  publication: {
    id: 'publication-1',
    title: 'Immersive Urban Analytics',
    authors: 'A. Author',
    abstract: 'A study of urban data in virtual reality.',
    venue: null,
    doi: '10.1000/example',
    publisherUrl: null,
  },
  decision: {
    id: 'decision-1',
    outcome: 'include',
    criteriaAnswers: { 'criterion-1': true, 'criterion-2': false },
    notes: 'Looks relevant',
    version: 1,
  },
}

function renderMyDecisions(handler: Parameters<typeof mockFetch>[0], stage = 'title_abstract') {
  const fetchMock = mockFetch(handler)
  renderWithProviders(<MyDecisionsPage />, {
    route: `/projects/project-1/screening/${stage}/my-decisions`,
    path: '/projects/:projectId/screening/:stage/my-decisions',
  })
  return fetchMock
}

describe('MyDecisionsPage', () => {
  it('lists previously submitted decisions', async () => {
    renderMyDecisions(async (input) => {
      if (String(input).endsWith('/my-decisions')) {
        return jsonResponse({ stageCompleted: false, criteria, items: [baseItem] })
      }
      return jsonResponse({})
    })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByText(/Include/)).toBeInTheDocument()
    expect(screen.getByText('Looks relevant', { exact: false })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a warning banner once the stage has been completed', async () => {
    renderMyDecisions(async (input) => {
      if (String(input).endsWith('/my-decisions')) {
        return jsonResponse({ stageCompleted: true, criteria, items: [baseItem] })
      }
      return jsonResponse({})
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(/already been finalized/)
  })

  it('lets a reviewer edit and resave a decision without extra confirmation while the stage is open', async () => {
    const fetchMock = renderMyDecisions(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/my-decisions')) {
        return jsonResponse({ stageCompleted: false, criteria, items: [baseItem] })
      }
      if (path.endsWith('/decision') && init?.method === 'POST') {
        return jsonResponse({ id: 'decision-1', outcome: 'exclude', criteriaAnswers: {}, notes: null, version: 2 })
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Decision' }))

    const saveButton = await screen.findByRole('button', { name: 'Save Changes' })
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([input, init]) => String(input).endsWith('/work-items/work-1/decision') && init?.method === 'POST',
      )).toBe(true)
    })
  })

  it('shows the LLM assistance panel while editing a past decision', async () => {
    renderMyDecisions(async (input) => {
      const path = String(input)
      if (path.endsWith('/my-decisions')) {
        return jsonResponse({ stageCompleted: false, criteria, items: [baseItem] })
      }
      if (path.endsWith('/work-items/work-1/llm-title-abstract')) {
        return jsonResponse({
          state: 'ready', hidden: false, runId: 'run-1', documentId: 'doc-1',
          model: 'test-model', promptVersion: 'v1', stale: false, error: null,
          suggestedDecision: 'include', confidence: 'high',
          reasoningSummary: 'Meets the inclusion criteria.', criteria: [],
        })
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    expect(screen.queryByText(/LLM assistance/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Decision' }))

    expect(await screen.findByText('Meets the inclusion criteria.')).toBeInTheDocument()
    expect(screen.getByText(/LLM suggestion:/).closest('p')).toHaveTextContent('include')
  })

  it('requires an extra confirmation before saving an edit once the stage is completed', async () => {
    const fetchMock = renderMyDecisions(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/my-decisions')) {
        return jsonResponse({ stageCompleted: true, criteria, items: [baseItem] })
      }
      if (path.endsWith('/decision') && init?.method === 'POST') {
        return jsonResponse({ id: 'decision-1', outcome: 'exclude', criteriaAnswers: {}, notes: null, version: 2 })
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Decision' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }))

    const decisionCalls = () => fetchMock.mock.calls.filter(
      ([input, init]) => String(input).endsWith('/work-items/work-1/decision') && init?.method === 'POST',
    )
    expect(decisionCalls()).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Save Anyway' }))
    await waitFor(() => expect(decisionCalls()).toHaveLength(1))
  })
})
