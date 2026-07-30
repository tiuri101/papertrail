import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { AdminGate } from '../AdminGate'
import type { LoginResponse } from '../types'
import { createTestQueryClient, renderWithProviders } from '../../../test/render'

function renderAdminGate(isAdmin: boolean) {
  const queryClient = createTestQueryClient()
  const session: LoginResponse = {
    user: { id: 'u1', username: 'user', displayName: 'User', isAdmin, isActive: true },
    csrfToken: 'csrf',
  }
  queryClient.setQueryData(['session'], session)
  return renderWithProviders(
    <Routes>
      <Route element={<AdminGate />}>
        <Route path="/users" element={<p>User administration</p>} />
      </Route>
      <Route path="/" element={<p>Home page</p>} />
    </Routes>,
    { route: '/users', queryClient },
  )
}

describe('AdminGate', () => {
  it('allows the administrator to enter', () => {
    renderAdminGate(true)
    expect(screen.getByText('User administration')).toBeInTheDocument()
  })

  it('redirects a reviewer away from administrator routes', () => {
    renderAdminGate(false)
    expect(screen.getByText('Home page')).toBeInTheDocument()
  })
})
