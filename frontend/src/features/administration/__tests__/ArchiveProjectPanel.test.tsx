import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ArchiveProjectPanel } from '../ArchiveProjectPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function clickCardAction(name: string) {
  const button = screen.getAllByRole('button', { name })
    .find((candidate) => !candidate.hasAttribute('aria-expanded'))!
  fireEvent.click(button)
}

describe('ArchiveProjectPanel', () => {
  it('archives an active project after confirming the email notice', async () => {
    let archivedAt: string | null = null
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'POST') {
        archivedAt = '2026-11-10T10:00:00Z'
        return jsonResponse({ id: 'p1', archivedAt })
      }
      return jsonResponse({ id: 'p1', archivedAt })
    })
    renderWithProviders(<ArchiveProjectPanel projectId="p1" />)

    // The section header is also named "Archive Project"; wait for the action itself.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Archive Project' })).toHaveLength(2))
    clickCardAction('Archive Project')
    expect(screen.getByRole('alert')).toHaveTextContent('All project members will be notified by email.')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/archive')
    })
    expect(await screen.findByRole('button', { name: 'Restore Project' })).toBeVisible()
  })

  it('restores an archived project', async () => {
    const fetchMock = mockFetch((_input, init) =>
      jsonResponse({ id: 'p1', archivedAt: init?.method === 'POST' ? null : '2026-11-10T10:00:00Z' }),
    )
    renderWithProviders(<ArchiveProjectPanel projectId="p1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Restore Project' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Restore' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/unarchive')
    })
  })
})
