import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { ChangePasswordPage } from '../ChangePasswordPage'
import { MIN_PASSWORD_LENGTH, PASSWORD_REQUIREMENTS_TEXT } from '../passwordPolicy'
import { sessionQueryOptions } from '../sessionQuery'
import type { LoginResponse } from '../types'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function renderChangePassword(session: LoginResponse) {
  const queryClient = renderWithProviders(
    <Routes>
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="/" element={<p>Home destination</p>} />
      <Route path="/help" element={<p>Help destination</p>} />
    </Routes>,
    { route: '/change-password' },
  ).queryClient
  queryClient.setQueryData(sessionQueryOptions.queryKey, session)
  return queryClient
}

describe('ChangePasswordPage', () => {
  it('submits the new password and offers Help before entering the application', async () => {
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

    const welcomeDialog = await screen.findByRole('alertdialog', { name: 'New to Papertrail?' })
    expect(welcomeDialog).toHaveTextContent('Take a look at the Help section')
    expect(screen.getByRole('button', { name: 'Explore Help' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue to Papertrail' })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/me', expect.objectContaining({ method: 'PATCH' }))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      currentPassword: 'temporary-password',
      newPassword: 'chosen-password',
    })
    expect(queryClient.getQueryData<LoginResponse>(sessionQueryOptions.queryKey)?.user.mustChangePassword).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Explore Help' }))
    expect(await screen.findByText('Help destination')).toBeInTheDocument()
  })

  it('allows the user to proceed directly to the application from the welcome dialog', async () => {
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
    mockFetch(() => jsonResponse({ ...session.user, mustChangePassword: false }))
    renderChangePassword(session)

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'temporary-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'chosen-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'chosen-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set Password' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Continue to Papertrail' }))
    expect(await screen.findByText('Home destination')).toBeInTheDocument()
  })

  it('requires the new password to differ from the temporary password', () => {
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
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'temporary-password' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'temporary-password' } })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'New password must be different from your current password.',
    )
    expect(screen.getByRole('button', { name: 'Set Password' })).toBeDisabled()
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

  it('states the length requirement and blocks a password below it', () => {
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

    expect(screen.getByText(PASSWORD_REQUIREMENTS_TEXT)).toBeInTheDocument()

    const tooShort = 'a'.repeat(MIN_PASSWORD_LENGTH - 1)
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'temporary-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: tooShort } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: tooShort } })
    expect(screen.getByRole('button', { name: 'Set Password' })).toBeDisabled()

    const longEnough = 'a'.repeat(MIN_PASSWORD_LENGTH)
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: longEnough } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: longEnough } })
    expect(screen.getByRole('button', { name: 'Set Password' })).toBeEnabled()
  })
})
