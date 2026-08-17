import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BrowserPdfRetrievalPanel } from '../BrowserPdfRetrievalPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const pairedAgent = {
  id: 'agent-1',
  displayName: 'Chrome on Desktop',
  lastSeenAt: '2026-08-15T10:00:00Z',
  extensionVersion: '1.0.0',
}

function runningBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'batch-1',
    projectId: 'p1',
    status: 'running',
    createdAt: '2026-08-15T10:00:00Z',
    completedAt: null,
    cancelledAt: null,
    progress: {
      total: 83,
      queued: 40,
      active: 1,
      succeeded: 35,
      needsAuthentication: 3,
      notFound: 2,
      accessDenied: 1,
      invalidResponse: 1,
      failed: 0,
      cancelled: 0,
      skippedExisting: 0,
      processed: 42,
    },
    attentionJobs: [],
    succeededPublicationIds: [],
    ...overrides,
  }
}

function render({
  agents = [pairedAgent],
  missingCount = 5,
  batches = [] as unknown[],
  extraHandler,
}: {
  agents?: unknown[]
  missingCount?: number
  batches?: unknown[]
  extraHandler?: (path: string, init?: RequestInit) => Response | undefined
} = {}) {
  let currentBatches = batches
  const fetchMock = mockFetch((input, init) => {
    const path = String(input)
    const extra = extraHandler?.(path, init)
    if (extra) return extra
    if (path.endsWith('/browser-agents')) return jsonResponse(agents)
    if (path.endsWith('/pdf-retrieval-batches/missing-count')) {
      return jsonResponse({ missingCount })
    }
    if (path.endsWith('/pdf-retrieval-batches') && (!init || init.method === undefined)) {
      return jsonResponse(currentBatches)
    }
    if (path.endsWith('/pdf-retrieval-batches') && init?.method === 'POST') {
      const created = runningBatch()
      currentBatches = [created]
      return jsonResponse({ batch: created })
    }
    if (path.includes('/cancel') && init?.method === 'POST') {
      return jsonResponse(runningBatch({ status: 'cancelled', cancelledAt: '2026-08-15T10:05:00Z' }))
    }
    if (path.includes('/retry-failed') && init?.method === 'POST') {
      return jsonResponse(runningBatch())
    }
    return jsonResponse({})
  })
  renderWithProviders(<BrowserPdfRetrievalPanel projectId="p1" />)
  fireEvent.click(screen.getByRole('button', { name: 'PDF retrieval' }))
  return fetchMock
}

describe('BrowserPdfRetrievalPanel', () => {
  it('shows a message and a link to Account Settings when no helper is paired', async () => {
    render({ agents: [] })

    expect(await screen.findByText(/No browser helper is paired/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Account Settings' })).toHaveAttribute('href', '/account')
  })

  it('shows the paired helper and missing publication count', async () => {
    render({ agents: [pairedAgent], missingCount: 37 })

    expect(await screen.findByText(/37 publications are missing full text/)).toBeInTheDocument()
    expect(screen.getByText(/Chrome on Desktop/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retrieve missing PDFs' })).toBeEnabled()
  })

  it('disables retrieval when there are no missing publications', async () => {
    render({ agents: [pairedAgent], missingCount: 0 })

    expect(await screen.findByRole('button', { name: 'Retrieve missing PDFs' })).toBeDisabled()
  })

  it('creates a retrieval batch and shows active progress', async () => {
    const fetchMock = render({ agents: [pairedAgent], missingCount: 83, batches: [] })

    const button = await screen.findByRole('button', { name: 'Retrieve missing PDFs' })
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByText('42 / 83 processed')).toBeInTheDocument())
    expect(screen.getByText(/35 retrieved/)).toBeInTheDocument()
    expect(screen.getByText('3 authentication required')).toBeInTheDocument()
    expect(screen.getByText('2 not found')).toBeInTheDocument()
    expect(screen.getByText('2 inaccessible/failed')).toBeInTheDocument()
    expect(screen.getByText('41 remaining')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Cancel retrieval/ })).toBeInTheDocument()

    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith('/pdf-retrieval-batches') && init?.method === 'POST',
    )
    expect(createCall).toBeDefined()
  })

  it('shows attention jobs with a short error and a retry action', async () => {
    const batch = runningBatch({
      status: 'completed',
      completedAt: '2026-08-15T10:10:00Z',
      attentionJobs: [
        {
          jobId: 'job-1',
          publicationId: 'pub-1',
          title: 'Immersive Analytics for Urban Planning',
          status: 'needs_authentication',
          errorCode: 'auth_required',
          errorMessage: 'Publisher requires institutional sign-in',
          resolvedLandingUrl: 'https://link.springer.com/article/123',
        },
      ],
    })
    const fetchMock = render({ agents: [pairedAgent], missingCount: 0, batches: [batch] })

    expect(await screen.findByText('Immersive Analytics for Urban Planning')).toBeInTheDocument()
    expect(screen.getByText(/Authentication required/)).toBeInTheDocument()
    expect(screen.getByText(/Publisher requires institutional sign-in/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }))

    await waitFor(() => {
      const retryCall = fetchMock.mock.calls.find(
        ([input, init]) => String(input).includes('/retry-failed') && init?.method === 'POST',
      )
      expect(retryCall).toBeDefined()
    })
  })

  it('cancels an active retrieval batch', async () => {
    const fetchMock = render({ agents: [pairedAgent], missingCount: 40, batches: [runningBatch()] })

    const cancelButton = await screen.findByRole('button', { name: /Cancel retrieval/ })
    fireEvent.click(cancelButton)

    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find(
        ([input, init]) => String(input).includes('/cancel') && init?.method === 'POST',
      )
      expect(cancelCall).toBeDefined()
    })
  })
})
