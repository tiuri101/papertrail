import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReconciliationPage } from '../ReconciliationPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const queueItem = {
  publication: {
    id: 'publication-1',
    title: 'Urban Data in VR',
    authors: 'Doe, Jane',
    doi: '10.1/vr',
    publisherUrl: null,
  },
}

const detail = {
  publication: queueItem.publication,
  fullTextAvailable: true,
  fields: [
    { stableKey: 'outcome', label: 'Outcome', fieldType: 'single_select', required: true, position: 0, options: ['Positive', 'Negative'] },
    { stableKey: 'summary', label: 'Summary', fieldType: 'long_text', required: true, position: 1, options: [] },
    { stableKey: 'themes', label: 'Themes', fieldType: 'multiple_select', required: false, position: 2, options: ['A', 'B'] },
  ],
  comparisons: [
    { stableKey: 'outcome', fieldType: 'single_select', valueA: 'Positive', valueB: 'Negative', agree: false },
    { stableKey: 'summary', fieldType: 'long_text', valueA: 'A summary', valueB: 'A different summary', agree: false },
    { stableKey: 'themes', fieldType: 'multiple_select', valueA: ['A'], valueB: ['A'], agree: true },
  ],
}

function routeOptions() {
  return {
    route: '/projects/p1/extraction/reconciliation',
    path: '/projects/:projectId/extraction/reconciliation',
  }
}

describe('ReconciliationPage', () => {
  it('blocks members without adjudication permission', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false, canAdjudicate: false })
      return jsonResponse([])
    })
    renderWithProviders(<ReconciliationPage />, routeOptions())

    expect(await screen.findByText(/Only project managers or adjudicators/)).toBeInTheDocument()
  })

  it('lists queued publications and shows agreeing/disagreeing fields when reconciling', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canAdjudicate: true })
      if (path.endsWith('/extraction/reconciliation')) return jsonResponse([queueItem])
      if (path.endsWith('/extraction/reconciliation/publication-1')) return jsonResponse(detail)
      if (path.includes('/full-text')) return jsonResponse({ available: true, document: null })
      return jsonResponse(null)
    })
    renderWithProviders(<ReconciliationPage />, routeOptions())

    expect(await screen.findByRole('heading', { name: 'Urban Data in VR' })).toBeInTheDocument()
    expect(screen.getByText('1 publication awaiting reconciliation')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }))

    await screen.findByText('Positive')
    expect(screen.getByText('Negative')).toBeInTheDocument()
    expect(screen.getByText('Agreed')).toBeInTheDocument()
    expect(screen.getAllByText('A')).toHaveLength(1)
  })

  it('submits a mixed A/B/manual reconciliation with a note', async () => {
    let resolved = false
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canAdjudicate: true })
      if (init?.method === 'POST' && path.endsWith('/extraction/reconciliation/publication-1')) {
        resolved = true
        return jsonResponse({ id: 'final-1', resolutionMethod: 'reconciliation' }, 201)
      }
      if (path.endsWith('/extraction/reconciliation')) return jsonResponse(resolved ? [] : [queueItem])
      if (path.endsWith('/extraction/reconciliation/publication-1')) return jsonResponse(detail)
      if (path.includes('/full-text')) return jsonResponse({ available: true, document: null })
      return jsonResponse(null)
    })
    renderWithProviders(<ReconciliationPage />, routeOptions())

    await screen.findByRole('heading', { name: 'Urban Data in VR' })
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile' }))
    await screen.findByText('Positive')

    const submitButton = screen.getByRole('button', { name: 'Submit Reconciliation' })
    expect(submitButton).toBeDisabled()

    // Row order matches the comparisons array: outcome (index 0), summary (index 1).
    fireEvent.click(screen.getAllByRole('button', { name: 'Use A' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Manual' })[1])
    fireEvent.change(screen.getByLabelText('Manual value'), { target: { value: 'A reconciled summary' } })
    fireEvent.change(screen.getByLabelText('Reconciliation note'), { target: { value: 'Checked against PDF' } })

    expect(submitButton).not.toBeDisabled()
    fireEvent.click(submitButton)

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([input, init]) => init?.method === 'POST' && String(input).endsWith('/extraction/reconciliation/publication-1'),
      )
      expect(postCall).toBeTruthy()
      expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
        fieldChoices: {
          outcome: { choice: 'response_a' },
          summary: { choice: 'manual', value: 'A reconciled summary' },
        },
        note: 'Checked against PDF',
      })
    })

    await waitFor(() => {
      expect(screen.getByText('0 publications awaiting reconciliation')).toBeInTheDocument()
    })
  })
})
