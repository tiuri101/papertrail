import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { ChangePasswordPage } from '../ChangePasswordPage'
import { sessionQueryOptions } from '../sessionQuery'
import type { LoginResponse } from '../types'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function renderChangePassword(session: LoginResponse) {
  const queryClient = renderWithProviders(
    <Routes>
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="/" element={<p>Home destination</p>} />
    </Routes>,
    { route: '/change-password' },
  ).queryClient
  queryClient.setQueryData(sessionQueryOptions.queryKey, session)
  return queryClient
}

describe('ChangePasswordPage', () => {
  it('submits the new password and navigates home on success', async () => {
    const session: LoginResponse = {
      user: {
        id: 'u1',
        username: 'newbie',
        displayName: 'Newbie',
        isAdmin: false,
        isActive: true,
        mustChangePassword: true,
      },
      csrfToken: 'csrf-session',
    }
    const updatedUser = { ...session.user, mustChangePassword: false }
    const fetchMock = mockFetch(() => jsonResponse(updatedUser))
    const queryClient = renderChangePassword(session)

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'temporary-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'chosen-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'chosen-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set Password' }))

    expect(await screen.findByText('Home destination')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/me', expect.objectContaining({ method: 'PATCH' }))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      currentPassword: 'temporary-password',
      newPassword: 'chosen-password',
    })
    expect(queryClient.getQueryData<LoginResponse>(sessionQueryOptions.queryKey)?.user.mustChangePassword).toBe(false)
  })

  it('shows a mismatch error and disables submission', () => {
    const session: LoginResponse = {
      user: {
        id: 'u1',
        username: 'newbie',
        displayName: 'Newbie',
        isAdmin: false,
        isActive: true,
        mustChangePassword: true,
      },
      csrfToken: 'csrf-session',
    }
    renderChangePassword(session)

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'temporary-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'chosen-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different-password' } })

    expect(screen.getByRole('alert')).toHaveTextContent('New passwords do not match.')
    expect(screen.getByRole('button', { name: 'Set Password' })).toBeDisabled()
  })

  it('shows the API error when the current password is wrong', async () => {
    const session: LoginResponse = {
      user: {
        id: 'u1',
        username: 'newbie',
        displayName: 'Newbie',
        isAdmin: false,
        isActive: true,
        mustChangePassword: true,
      },
      csrfToken: 'csrf-session',
    }
    mockFetch(() => jsonResponse({ error: { message: 'Current password is incorrect' } }, 400))
    renderChangePassword(session)

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'chosen-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'chosen-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set Password' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Current password is incorrect'))
  })
})
