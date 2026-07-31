import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { AppShell } from '../AppShell'
import { getCsrfToken, setCsrfToken } from '../../features/auth/session'
import type { LoginResponse } from '../../features/auth/types'
import { emptyResponse, jsonResponse, mockFetch } from '../../test/http'
import { createTestQueryClient, renderWithProviders } from '../../test/render'

function renderShell(session: LoginResponse) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(['session'], session)
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<p>Dashboard</p>} />
      </Route>
      <Route path="/login" element={<p>Login page</p>} />
    </Routes>,
    { queryClient },
  )
}

const reviewerSession: LoginResponse = {
  user: { id: 'reviewer', username: 'reviewer', displayName: 'Reviewer', isAdmin: false, isActive: true },
  csrfToken: 'csrf',
}

describe('AppShell', () => {
  it('does not expose user administration to reviewers', () => {
    renderShell(reviewerSession)
    expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
  })

  it('shows user administration to the administrator', () => {
    renderShell({
      ...reviewerSession,
      user: { ...reviewerSession.user, id: 'admin', username: 'admin', isAdmin: true },
    })
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users')
  })

  it('logs out, clears client session state, and navigates to login', async () => {
    setCsrfToken('csrf')
    const fetchMock = mockFetch(() => emptyResponse())
    const { queryClient } = renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))

    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(queryClient.getQueryData(['session'])).toBeUndefined()
    expect(getCsrfToken()).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({ method: 'POST' }))
  })

  it('keeps the current screen and reports a logout failure', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Logout failed' } }, 500))
    renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Logout failed'))
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
  })
})
