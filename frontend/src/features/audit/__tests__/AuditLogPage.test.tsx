import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AuditLogPage } from '../AuditLogPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('AuditLogPage', () => {
  it('lists audit events with actor, action, entity, and summary', async () => {
    mockFetch((input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      return jsonResponse([
        {
          id: 'event-1',
          createdAt: '2026-07-30T08:00:00Z',
          actorUsername: 'admin1',
          action: 'project.created',
          entityType: 'project',
          entityId: 'project-1',
          summary: 'Created project Sample Review',
          metadata: {},
        },
        {
          id: 'event-2',
          createdAt: '2026-07-30T09:00:00Z',
          actorUsername: null,
          action: 'project.completed',
          entityType: 'project',
          entityId: 'project-1',
          summary: 'Project completed automatically',
          metadata: {},
        },
      ])
    })
    renderWithProviders(<AuditLogPage />, { route: '/projects/p1/audit', path: '/projects/:projectId/audit' })

    const firstRow = (await screen.findByText('Created project Sample Review')).closest('tr') as HTMLElement
    expect(within(firstRow).getByText('admin1')).toBeInTheDocument()
    expect(within(firstRow).getByText('project.created')).toBeInTheDocument()
    expect(within(firstRow).getByText('project (project-1)')).toBeInTheDocument()

    const secondRow = screen.getByText('Project completed automatically').closest('tr') as HTMLElement
    expect(within(secondRow).getByText('System')).toBeInTheDocument()
  })

  it('shows a message when there are no audit events yet', async () => {
    mockFetch((input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      return jsonResponse([])
    })
    renderWithProviders(<AuditLogPage />, { route: '/projects/p1/audit', path: '/projects/:projectId/audit' })

    expect(await screen.findByText('No audit events recorded yet.')).toBeInTheDocument()
  })

  it('filters by action and sorts by clicking a column header', async () => {
    mockFetch((input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      return jsonResponse([
        {
          id: 'event-1',
          createdAt: '2026-07-30T08:00:00Z',
          actorUsername: 'admin1',
          action: 'project.created',
          entityType: 'project',
          entityId: 'project-1',
          summary: 'Created project Sample Review',
          metadata: {},
        },
        {
          id: 'event-2',
          createdAt: '2026-07-30T09:00:00Z',
          actorUsername: null,
          action: 'project.completed',
          entityType: 'project',
          entityId: 'project-1',
          summary: 'Project completed automatically',
          metadata: {},
        },
      ])
    })
    renderWithProviders(<AuditLogPage />, { route: '/projects/p1/audit', path: '/projects/:projectId/audit' })

    await screen.findByText('Created project Sample Review')

    const actionSelect = screen.getByLabelText('Action')
    fireEvent.change(actionSelect, { target: { value: 'project.completed' } })
    expect(screen.queryByText('Created project Sample Review')).not.toBeInTheDocument()
    expect(screen.getByText('Project completed automatically')).toBeInTheDocument()

    fireEvent.change(actionSelect, { target: { value: '' } })
    const rowsBeforeSort = screen.getAllByRole('row').slice(1)
    expect(within(rowsBeforeSort[0]).getByText('Project completed automatically')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Timestamp/ }))
    const rowsAfterSort = screen.getAllByRole('row').slice(1)
    expect(within(rowsAfterSort[0]).getByText('Created project Sample Review')).toBeInTheDocument()
  })
})
