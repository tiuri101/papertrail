import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UsersPage } from '../UsersPage'
import type { LoginResponse } from '../../auth/types'
import { jsonResponse, mockFetch } from '../../../test/http'
import { createTestQueryClient, renderWithProviders } from '../../../test/render'

const adminSession: LoginResponse = {
  user: { id: 'admin', username: 'admin', displayName: 'Administrator', isAdmin: true, isActive: true },
  csrfToken: 'csrf-token',
}

describe('UsersPage', () => {
  it('lists users in a table and creates a reviewer via the create-reviewer form', async () => {
    const users = [
      { id: 'admin', username: 'admin', displayName: 'Administrator', isAdmin: true, isActive: true },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const created = { id: 'reviewer-1', ...body, isAdmin: false, isActive: true }
        users.push(created)
        return jsonResponse(created, 201)
      }
      return jsonResponse(users)
    })

    renderWithProviders(<UsersPage />)
    const table = await screen.findByRole('table')
    expect(within(table).getByText('Administrator')).toBeInTheDocument()
    expect(within(table).getByText('admin')).toBeInTheDocument()

    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add Reviewer' }))

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'reviewer' } })
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Review User' } })
    fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'temporary-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Reviewer' }))

    await waitFor(() => expect(within(screen.getByRole('table')).getByText('Review User')).toBeInTheDocument())
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      username: 'reviewer',
      displayName: 'Review User',
      password: 'temporary-password',
    })
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
  })

  it('shows a user-creation failure', async () => {
    mockFetch(async (_input, init) => init?.method === 'POST'
      ? jsonResponse({ error: { message: 'Username already exists' } }, 409)
      : jsonResponse([]))
    renderWithProviders(<UsersPage />)
    await screen.findByRole('heading', { name: 'Users' })

    fireEvent.click(screen.getByRole('button', { name: 'Add Reviewer' }))
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'existing' } })
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Existing' } })
    fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'temporary-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Reviewer' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Username already exists'))
  })

  it('hides the remove action for the signed-in admin\'s own row', async () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(['session'], adminSession)
    const users = [
      { id: 'admin', username: 'admin', displayName: 'Administrator', isAdmin: true, isActive: true },
      { id: 'reviewer-1', username: 'reviewer', displayName: 'Review User', isAdmin: false, isActive: true },
    ]
    mockFetch(() => jsonResponse(users))
    renderWithProviders(<UsersPage />, { queryClient })

    const adminRow = (await screen.findByText('Administrator')).closest('tr') as HTMLElement
    expect(within(adminRow).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    const reviewerRow = screen.getByText('Review User').closest('tr') as HTMLElement
    expect(within(reviewerRow).getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('removes another account after confirmation', async () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(['session'], adminSession)
    const users = [
      { id: 'admin', username: 'admin', displayName: 'Administrator', isAdmin: true, isActive: true },
      { id: 'reviewer-1', username: 'reviewer', displayName: 'Review User', isAdmin: false, isActive: true },
    ]
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'PATCH') {
        const updated = { ...users[1], isActive: false }
        return jsonResponse(updated)
      }
      return jsonResponse(users)
    })
    renderWithProviders(<UsersPage />, { queryClient })

    const reviewerRow = (await screen.findByText('Review User')).closest('tr') as HTMLElement
    fireEvent.click(within(reviewerRow).getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(reviewerRow).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(String(call?.[0])).toBe('/api/v1/users/reviewer-1')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ isActive: false })
    })
  })

  it('reactivates a disabled account', async () => {
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(['session'], adminSession)
    const users = [
      { id: 'admin', username: 'admin', displayName: 'Administrator', isAdmin: true, isActive: true },
      { id: 'reviewer-1', username: 'reviewer', displayName: 'Review User', isAdmin: false, isActive: false },
    ]
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'PATCH') {
        const updated = { ...users[1], isActive: true }
        return jsonResponse(updated)
      }
      return jsonResponse(users)
    })
    renderWithProviders(<UsersPage />, { queryClient })

    const reviewerRow = (await screen.findByText('Review User')).closest('tr') as HTMLElement
    expect(within(reviewerRow).getByText('disabled')).toBeInTheDocument()
    fireEvent.click(within(reviewerRow).getByRole('button', { name: 'Reactivate' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(String(call?.[0])).toBe('/api/v1/users/reviewer-1')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ isActive: true })
    })
  })
})
