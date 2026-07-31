import { fireEvent, screen, waitFor } from '@testing-library/react'
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

describe('DangerZonePanel', () => {
  it('resets the project only after confirming the warning', async () => {
    const fetchMock = mockFetch((_input, init) => {
      if (init?.method === 'POST') return jsonResponse({ id: 'p1', stage: 'draft' })
      return jsonResponse({})
    })
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Reset Project' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/deletes every imported publication/)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Reset Project' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Delete Project' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/permanently deletes the entire project/)

    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1')
    })
    expect(await screen.findByText('Projects list')).toBeInTheDocument()
  })
})
