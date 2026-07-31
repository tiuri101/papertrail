import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UsersPage } from '../UsersPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

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
    fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }))

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'reviewer' } })
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Review User' } })
    fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'temporary-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create reviewer' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }))
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'existing' } })
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Existing' } })
    fireEvent.change(screen.getByLabelText('Temporary password'), { target: { value: 'temporary-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create reviewer' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Username already exists'))
  })
})
