import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AccountSettingsPage } from '../AccountSettingsPage'
import { sessionQueryOptions } from '../sessionQuery'
import { jsonResponse, mockFetch } from '../../../test/http'
import { createTestQueryClient, renderWithProviders } from '../../../test/render'

const session = {
  user: { id: 'user-1', username: 'reviewer1', displayName: 'Reviewer One', isAdmin: false, isActive: true },
  csrfToken: 'csrf-token',
}

function renderWithSession() {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(sessionQueryOptions.queryKey, session)
  return renderWithProviders(<AccountSettingsPage />, { queryClient })
}

describe('AccountSettingsPage', () => {
  it('prefills the display name and saves changes', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/auth/me') && init?.method === 'PATCH') {
        return jsonResponse({ id: 'user-1', username: 'reviewer1', displayName: 'New Name', isAdmin: false, isActive: true })
      }
      return jsonResponse({})
    })
    renderWithSession()

    expect(screen.getByLabelText('Display name')).toHaveValue('Reviewer One')
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'New Name' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Display Name' }))

    await waitFor(() => expect(screen.getByText('Display name updated.')).toBeInTheDocument())
    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/auth/me'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ displayName: 'New Name' })
  })

  it('requires matching new passwords before enabling submit', async () => {
    mockFetch(async () => jsonResponse({}))
    renderWithSession()

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'different-password' } })

    expect(screen.getByText('New passwords do not match.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change Password' })).toBeDisabled()
  })

  it('submits a password change with the current and new password', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/auth/me') && init?.method === 'PATCH') {
        return jsonResponse({ id: 'user-1', username: 'reviewer1', displayName: 'Reviewer One', isAdmin: false, isActive: true })
      }
      return jsonResponse({})
    })
    renderWithSession()

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old-password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new-password-1' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'new-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change Password' }))

    await waitFor(() => expect(screen.getByText('Password updated.')).toBeInTheDocument())
    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/auth/me'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      currentPassword: 'old-password',
      newPassword: 'new-password-1',
    })
  })
})
