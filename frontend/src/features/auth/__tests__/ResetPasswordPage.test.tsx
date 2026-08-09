import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { ResetPasswordPage } from '../ResetPasswordPage'
import { getCsrfToken } from '../session'
import type { LoginResponse } from '../types'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function renderResetPassword(route = '/reset-password?token=reset-token-123') {
  return renderWithProviders(
    <Routes>
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/" element={<p>Home destination</p>} />
      <Route path="/forgot-password" element={<p>Forgot password destination</p>} />
    </Routes>,
    { route },
  )
}

describe('ResetPasswordPage', () => {
  it('submits the new password, stores the session, and navigates home', async () => {
    const response: LoginResponse = {
      user: { id: 'u1', username: 'reviewer', displayName: 'Reviewer', isAdmin: false, isActive: true },
      csrfToken: 'csrf-reset',
    }
    const fetchMock = mockFetch(() => jsonResponse(response))
    const { queryClient } = renderResetPassword()

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'brand-new-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'brand-new-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set New Password' }))

    expect(await screen.findByText('Home destination')).toBeInTheDocument()
    expect(getCsrfToken()).toBe('csrf-reset')
    expect(queryClient.getQueryData(['session'])).toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/reset-password',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      token: 'reset-token-123',
      newPassword: 'brand-new-password',
    })
  })

  it('shows a mismatch error and disables submission', () => {
    renderResetPassword()

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'brand-new-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different-password' } })

    expect(screen.getByRole('alert')).toHaveTextContent('New passwords do not match.')
    expect(screen.getByRole('button', { name: 'Set New Password' })).toBeDisabled()
  })

  it('shows the API error when the token is invalid or expired', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'This password reset link is invalid or has expired' } }, 400))
    renderResetPassword()

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'brand-new-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'brand-new-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set New Password' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This password reset link is invalid or has expired'))
  })

  it('shows a missing-token message and hides the form when no token is present', () => {
    renderResetPassword('/reset-password')

    expect(screen.getByRole('alert')).toHaveTextContent('This password reset link is missing its token')
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password')
  })
})
