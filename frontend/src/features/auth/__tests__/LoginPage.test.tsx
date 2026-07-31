import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { LoginPage } from '../LoginPage'
import { getCsrfToken } from '../session'
import type { LoginResponse } from '../types'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function renderLogin() {
  return renderWithProviders(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<p>Home destination</p>} />
    </Routes>,
    { route: '/login' },
  )
}

describe('LoginPage', () => {
  it('submits credentials, stores the session, and navigates home', async () => {
    const response: LoginResponse = {
      user: { id: 'admin', username: 'admin', displayName: 'Admin', isAdmin: true, isActive: true },
      csrfToken: 'csrf-login',
    }
    const fetchMock = mockFetch(() => jsonResponse(response))
    const { queryClient } = renderLogin()

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    expect(await screen.findByText('Home destination')).toBeInTheDocument()
    expect(getCsrfToken()).toBe('csrf-login')
    expect(queryClient.getQueryData(['session'])).toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      username: 'admin',
      password: 'correct horse battery staple',
    })
  })

  it('shows the API error and remains on the login page', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Invalid credentials' } }, 401))
    renderLogin()

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials'))
    expect(screen.getByRole('heading', { name: 'Sign In to Papertrail' })).toBeInTheDocument()
  })
})
