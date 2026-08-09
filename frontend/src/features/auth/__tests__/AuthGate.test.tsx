import { screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { AuthGate } from '../AuthGate'
import { getCsrfToken } from '../session'
import { renderWithProviders } from '../../../test/render'
import { jsonResponse, mockFetch } from '../../../test/http'

function renderGate() {
  return renderWithProviders(
    <Routes>
      <Route element={<AuthGate />}>
        <Route path="/" element={<p>Protected content</p>} />
      </Route>
      <Route path="/login" element={<p>Login destination</p>} />
    </Routes>,
  )
}

describe('AuthGate', () => {
  it('loads the session, stores the CSRF token, and renders protected content', async () => {
    mockFetch(() => jsonResponse({
      user: { id: 'u1', username: 'reviewer', displayName: 'Reviewer', isAdmin: false, isActive: true },
      csrfToken: 'csrf-session',
    }))

    renderGate()

    expect(screen.getByText('Loading session…')).toBeInTheDocument()
    expect(await screen.findByText('Protected content')).toBeInTheDocument()
    expect(getCsrfToken()).toBe('csrf-session')
  })

  it('redirects an unauthenticated user to login', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Not authenticated' } }, 403))

    renderGate()

    expect(await screen.findByText('Login destination')).toBeInTheDocument()
    expect(getCsrfToken()).toBeNull()
  })

  it('shows a recoverable error for a failed session request', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Server unavailable' } }, 500))

    renderGate()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The session could not be loaded.'))
  })

  it('redirects a user who must change their password', async () => {
    mockFetch(() => jsonResponse({
      user: {
        id: 'u1',
        username: 'newbie',
        displayName: 'Newbie',
        isAdmin: false,
        isActive: true,
        mustChangePassword: true,
      },
      csrfToken: 'csrf-session',
    }))

    renderWithProviders(
      <Routes>
        <Route element={<AuthGate />}>
          <Route path="/" element={<p>Protected content</p>} />
          <Route path="/change-password" element={<p>Change password destination</p>} />
        </Route>
      </Routes>,
    )

    expect(await screen.findByText('Change password destination')).toBeInTheDocument()
  })
})
