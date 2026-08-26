import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { DangerZonePanel } from '../DangerZonePanel'
import { emptyResponse, jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function renderPanel() {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:projectId/admin" element={<DangerZonePanel projectId="p1" />} />
      <Route path="/projects" element={<p>Projects list</p>} />
    </Routes>,
    { route: '/projects/p1/admin' },
  )
}

function clickCardAction(name: string) {
  const button = screen.getAllByRole('button', { name })
    .find((candidate) => !candidate.hasAttribute('aria-expanded'))!
  fireEvent.click(button)
}

describe('DangerZonePanel', () => {
  it('resets the project only after confirming the warning', async () => {
    const fetchMock = mockFetch((_input, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'p1', stage: 'draft' })
      return jsonResponse({})
    })
    renderPanel()

    clickCardAction('Reset Project')
    expect(screen.getByRole('alert')).toHaveTextContent('Are you sure you want to continue? This cannot be undone.')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset Project' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/reset')
    })
  })

  it('deletes the project after confirming and navigates back to the projects list', async () => {
    const fetchMock = mockFetch((_input, init) => {
      if (init?.method === 'DELETE') return emptyResponse(204)
      return jsonResponse({})
    })
    renderPanel()

    clickCardAction('Delete Project')
    expect(screen.getByRole('alert')).toHaveTextContent('Are you sure you want to continue? This cannot be undone.')

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Permanently Delete' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1')
    })
    expect(await screen.findByText('Projects list')).toBeInTheDocument()
  })

  // Consumer update for Group C: a reset refused because a background handler
  // is mid-write is a wait-and-retry, and the UI has to say what to wait for.
  it('names the running background jobs when a reset is refused', async () => {
    mockFetch((_input, init) => {
      if (init?.method === 'POST') {
        return jsonResponse(
          {
            error: {
              code: 'project_jobs_running',
              message: 'Wait for running background jobs to finish before resetting the project',
              details: {
                operation: 'reset',
                runningJobCount: 2,
                runningJobTypes: ['import.process', 'duplicate.detect'],
              },
            },
          },
          409,
        )
      }
      return jsonResponse({})
    })
    renderPanel()

    clickCardAction('Reset Project')
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset Project' }))

    const alert = await screen.findByText(/background jobs are still running/)
    expect(alert).toHaveTextContent('2 background jobs are still running')
    expect(alert).toHaveTextContent('import process')
    expect(alert).toHaveTextContent('duplicate detect')
    expect(alert).toHaveTextContent('before resetting the project')
  })
})
