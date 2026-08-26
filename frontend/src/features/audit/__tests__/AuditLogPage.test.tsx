import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AuditLogPage } from '../AuditLogPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import type { AuditEvent } from '../types'

function event(overrides: Partial<AuditEvent> & Pick<AuditEvent, 'id' | 'summary'>): AuditEvent {
  return {
    createdAt: '2026-07-30T08:00:00Z',
    actorUsername: 'admin1',
    action: 'project.created',
    entityType: 'project',
    entityId: 'project-1',
    metadata: {},
    ...overrides,
  }
}

const created = event({
  id: 'event-1',
  summary: 'Created project Sample Review',
})
const completed = event({
  id: 'event-2',
  summary: 'Project completed automatically',
  createdAt: '2026-07-30T09:00:00Z',
  actorUsername: null,
  action: 'project.completed',
})

const filterOptions = {
  actions: ['project.completed', 'project.created'],
  entityTypes: ['project'],
  actors: [{ id: 'u1', name: 'admin1' }, { id: 'system', name: 'System' }],
}

/**
 * Serves the paged audit API. `pagesByQuery` is consulted with the request's
 * query string so a test can assert what the server was asked for.
 */
function renderAuditLog(
  respond: (params: URLSearchParams) => { items: AuditEvent[]; total: number; nextCursor?: string | null },
) {
  const fetchMock = mockFetch((input) => {
    const path = String(input)
    if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
    if (path.includes('/audit/filters')) return jsonResponse(filterOptions)
    if (path.includes('/audit')) {
      const params = new URLSearchParams(path.split('?')[1] ?? '')
      const page = respond(params)
      const nextCursor = page.nextCursor ?? null
      return jsonResponse({ ...page, nextCursor, hasMore: nextCursor !== null })
    }
    return jsonResponse({})
  })
  renderWithProviders(<AuditLogPage />, { route: '/projects/p1/audit', path: '/projects/:projectId/audit' })
  return fetchMock
}

function auditRequests(fetchMock: ReturnType<typeof mockFetch>): URLSearchParams[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((path) => path.includes('/audit') && !path.includes('/audit/filters'))
    .map((path) => new URLSearchParams(path.split('?')[1] ?? ''))
}

describe('AuditLogPage', () => {
  it('lists audit events with actor, action, entity, and summary', async () => {
    renderAuditLog(() => ({ items: [created, completed], total: 2 }))

    const firstRow = (await screen.findByText('Created project Sample Review')).closest('tr') as HTMLElement
    expect(within(firstRow).getByText('admin1')).toBeInTheDocument()
    expect(within(firstRow).getByText('project.created')).toBeInTheDocument()
    expect(within(firstRow).getByText('project (project-1)')).toBeInTheDocument()

    const secondRow = screen.getByText('Project completed automatically').closest('tr') as HTMLElement
    expect(within(secondRow).getByText('System')).toBeInTheDocument()
  })

  it('shows a message when there are no audit events yet', async () => {
    renderAuditLog(() => ({ items: [], total: 0 }))
    expect(await screen.findByText('No audit events recorded yet.')).toBeInTheDocument()
  })

  it('sorts the loaded events by clicking a column header', async () => {
    renderAuditLog(() => ({ items: [completed, created], total: 2 }))

    await screen.findByText('Created project Sample Review')
    const rowsBeforeSort = screen.getAllByRole('row').slice(1)
    expect(within(rowsBeforeSort[0]).getByText('Project completed automatically')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Timestamp/ }))
    const rowsAfterSort = screen.getAllByRole('row').slice(1)
    expect(within(rowsAfterSort[0]).getByText('Created project Sample Review')).toBeInTheDocument()
  })

  // Regression: filters used to narrow only the loaded page, so a project
  // whose matching events were older than the first page looked empty.
  it('filters on the server rather than over the loaded page', async () => {
    const fetchMock = renderAuditLog((params) => (
      params.get('action') === 'project.completed'
        ? { items: [completed], total: 1 }
        : { items: [created, completed], total: 2 }
    ))

    await screen.findByText('Created project Sample Review')
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'project.completed' } })

    await waitFor(() => {
      expect(screen.queryByText('Created project Sample Review')).not.toBeInTheDocument()
    })
    expect(await screen.findByText('Project completed automatically')).toBeInTheDocument()
    expect(auditRequests(fetchMock).some((params) => params.get('action') === 'project.completed')).toBe(true)
  })

  it('offers every filter value in the project, not just the ones on this page', async () => {
    renderAuditLog(() => ({ items: [created], total: 40, nextCursor: 'event-1' }))

    await screen.findByText('Created project Sample Review')
    const actionOptions = Array.from((screen.getByLabelText('Action') as HTMLSelectElement).options)
      .map((option) => option.value)
    // `project.completed` appears on no loaded row but is offered anyway.
    expect(actionOptions).toEqual(['', 'project.completed', 'project.created'])

    const actorOptions = Array.from((screen.getByLabelText('User') as HTMLSelectElement).options)
      .map((option) => option.value)
    expect(actorOptions).toEqual(['', 'u1', 'system'])
  })

  // Regression: the page showed only the newest default-limit records with no
  // way to reach the rest, and no sign that there was a rest.
  it('appends the next page and says how much of the history is loaded', async () => {
    const fetchMock = renderAuditLog((params) => (
      params.get('cursor') === 'event-1'
        ? { items: [completed], total: 2 }
        : { items: [created], total: 2, nextCursor: 'event-1' }
    ))

    await screen.findByText('Created project Sample Review')
    expect(screen.getByText(/Showing the 1 most recent of 2 events/)).toBeInTheDocument()
    expect(screen.getByText('1 of 2 audit events loaded')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load More Events' }))

    expect(await screen.findByText('Project completed automatically')).toBeInTheDocument()
    // Appended, not replaced.
    expect(screen.getByText('Created project Sample Review')).toBeInTheDocument()
    expect(screen.getByText('2 audit events')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load More Events' })).not.toBeInTheDocument()
    expect(auditRequests(fetchMock).map((params) => params.get('cursor'))).toEqual([null, 'event-1'])
  })

  it('restarts from the first page when a filter changes', async () => {
    const fetchMock = renderAuditLog((params) => {
      if (params.get('action') === 'project.completed') {
        return { items: [completed], total: 1 }
      }
      return params.get('cursor') === 'event-1'
        ? { items: [completed], total: 2 }
        : { items: [created], total: 2, nextCursor: 'event-1' }
    })

    await screen.findByText('Created project Sample Review')
    fireEvent.click(screen.getByRole('button', { name: 'Load More Events' }))
    await screen.findByText('Project completed automatically')

    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'project.completed' } })

    await waitFor(() => {
      expect(screen.queryByText('Created project Sample Review')).not.toBeInTheDocument()
    })
    // The filtered fetch starts a fresh first page rather than continuing
    // from the cursor gathered under the previous filter.
    const filteredRequests = auditRequests(fetchMock).filter(
      (params) => params.get('action') === 'project.completed',
    )
    expect(filteredRequests).toHaveLength(1)
    expect(filteredRequests[0].get('cursor')).toBeNull()
    expect(await screen.findByText('1 matching audit event')).toBeInTheDocument()
  })
})
