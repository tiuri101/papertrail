import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from 'react-router-dom'

import { apiRequest } from '../api/client'
import { setCsrfToken } from '../features/auth/session'
import type { LoginResponse } from '../features/auth/types'

export function AppShell() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = queryClient.getQueryData<LoginResponse>(['session'])
  const logout = useMutation({
    mutationFn: () => apiRequest<void>('/api/v1/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      setCsrfToken(null)
      queryClient.clear()
      navigate('/login')
    },
  })

  return (
    <>
      <header className="app-header">
        <Link className="brand" to="/">Papertrail</Link>
        <nav aria-label="Primary navigation">
          <Link to="/projects">Projects</Link>
          {session?.user.isAdmin ? <Link to="/users">Users</Link> : null}
          <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>Sign out</button>
        </nav>
      </header>
      {logout.error ? <p className="page error" role="alert">{logout.error.message}</p> : null}
      <Outlet />
    </>
  )
}
