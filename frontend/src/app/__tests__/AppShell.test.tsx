import { fireEvent, screen, waitFor, within } from '@testing-library/react'
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
    expect(screen.queryByRole('link', { name: 'Instance Settings' })).not.toBeInTheDocument()
  })

  it('exposes Help to every signed-in user', () => {
    renderShell(reviewerSession)
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help')
  })

  it('shows user administration to the administrator', () => {
    renderShell({
      ...reviewerSession,
      user: { ...reviewerSession.user, id: 'admin', username: 'admin', isAdmin: true },
    })
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users')
    expect(screen.getByRole('link', { name: 'Instance Settings' })).toHaveAttribute('href', '/instance-settings')
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

  it('exposes Account (and Users, for admins) from the mobile menu', () => {
    renderShell({
      ...reviewerSession,
      user: { ...reviewerSession.user, id: 'admin', username: 'admin', isAdmin: true },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    expect(within(drawer).getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users')
    expect(within(drawer).getByRole('link', { name: 'Instance Settings' })).toHaveAttribute('href', '/instance-settings')
    expect(within(drawer).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account')
    expect(within(drawer).getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help')
  })

  it('hides Users and Instance Settings from the mobile menu for reviewers', () => {
    renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    expect(within(drawer).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('link', { name: 'Instance Settings' })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('link', { name: 'Account' })).toBeInTheDocument()
  })

  it('signs out from the mobile menu', async () => {
    setCsrfToken('csrf')
    const fetchMock = mockFetch(() => emptyResponse())
    const { queryClient } = renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sign Out' }))

    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(queryClient.getQueryData(['session'])).toBeUndefined()
    expect(getCsrfToken()).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({ method: 'POST' }))
  })

  it('closes the mobile menu with Escape', () => {
    renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    expect(screen.getByRole('dialog', { name: 'Main menu' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Main menu' })).not.toBeInTheDocument()
  })
})
