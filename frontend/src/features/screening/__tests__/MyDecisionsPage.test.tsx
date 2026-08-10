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
    expect(screen.getByText('Include', { selector: '.status-badge' })).toBeInTheDocument()
    expect(screen.getByText('Looks relevant', { exact: false })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('lists full-text retrieval decisions when a report was not accessible', async () => {
    renderMyDecisions(async (input) => {
      if (String(input).endsWith('/my-decisions')) {
        return jsonResponse({
          stageCompleted: false,
          criteria,
          items: [{
            ...baseItem,
            workItemId: 'retrieval-1',
            decision: null,
            retrievalStatus: 'inaccessible',
            retrievalNote: 'Paywall could not be bypassed',
          }],
        })
      }
      return jsonResponse({})
    }, 'full_text')

    expect(
      await screen.findByText('Full text inaccessible', { selector: '.status-badge' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Paywall could not be bypassed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Decision' })).not.toBeInTheDocument()
  })

  it('searches, filters, and sorts full-text decisions', async () => {
    const excludedItem = {
      ...baseItem,
      workItemId: 'work-2',
      submittedAt: '2026-03-01T00:00:00Z',
      publication: { ...baseItem.publication, id: 'publication-2', title: 'Alpha Study' },
      decision: { ...baseItem.decision, id: 'decision-2', outcome: 'exclude' },
    }
    const inaccessibleItem = {
      ...baseItem,
      workItemId: 'retrieval-1',
      submittedAt: '2026-02-01T00:00:00Z',
      publication: {
        ...baseItem.publication,
        id: 'publication-3',
        title: 'Zebra Report',
        authors: 'Z. Reviewer',
      },
      decision: null,
      retrievalStatus: 'inaccessible',
      retrievalNote: 'No institutional access',
    }
    renderMyDecisions(async (input) => {
      if (String(input).endsWith('/my-decisions')) {
        return jsonResponse({
          stageCompleted: false,
          criteria,
          items: [baseItem, inaccessibleItem, excludedItem],
        })
      }
      return jsonResponse({})
    }, 'full_text')

    await screen.findByRole('heading', { name: 'Alpha Study' })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Alpha Study',
      'Zebra Report',
      'Immersive Urban Analytics',
    ])

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'title_asc' } })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Alpha Study',
      'Immersive Urban Analytics',
      'Zebra Report',
    ])

    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'inaccessible' } })
    expect(screen.getByRole('heading', { name: 'Zebra Report' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Alpha Study' })).not.toBeInTheDocument()
    expect(screen.getByText('1 of 3 decisions match your filters')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Search papers'), { target: { value: 'Z. Reviewer' } })
    expect(screen.getByRole('heading', { name: 'Zebra Report' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Immersive Urban Analytics' })).not.toBeInTheDocument()
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

  it('keeps the current project stage and lists outstanding work after a late revision', async () => {
    renderMyDecisions(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/my-decisions')) {
        return jsonResponse({ stageCompleted: true, criteria, items: [baseItem] })
      }
      if (path.endsWith('/decision') && init?.method === 'POST') {
        return jsonResponse({
          id: 'decision-1',
          outcome: 'include',
          criteriaAnswers: baseItem.decision.criteriaAnswers,
          notes: null,
          version: 2,
          projectStage: 'extraction_quality',
          stageUnchanged: true,
          pendingWorkflowSteps: [
            'Complete full-text screening',
            'Wait for automated document and LLM processing',
          ],
        })
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Decision' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Anyway' }))

    const warning = await screen.findByRole('heading', {
      name: 'Decision revised without changing the project stage',
    })
    expect(warning.closest('[role="alert"]')).toHaveTextContent(
      'The project remains in Data Extraction and Quality Assessment',
    )
    expect(warning.closest('[role="alert"]')).toHaveTextContent('Complete full-text screening')
    expect(warning.closest('[role="alert"]')).toHaveTextContent(
      'Wait for automated document and LLM processing',
    )
  })
})
