import { useMutation, useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { apiRequest } from '../api/client'
import { ThemeToggle } from '../components/ThemeToggle'
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
        <div className="app-header__content">
          <NavLink className="brand" to="/" aria-label="Papertrail home">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 3h8.5L19 7.5V21H6V3Zm2 2v14h9V9h-4V5H8Zm7 1.4V7h.6L15 6.4Z" />
                <path d="M9.5 11h5v1.7h-5V11Zm0 3.4h5v1.7h-5v-1.7Z" />
              </svg>
            </span>
            <span>Papertrail</span>
          </NavLink>
          <div className="app-header__actions">
            <nav aria-label="Primary navigation">
              <NavLink to="/projects" className={({ isActive }) => isActive ? 'nav-link nav-link--active' : 'nav-link'}>
                Projects
              </NavLink>
              {session?.user.isAdmin ? (
                <NavLink to="/users" className={({ isActive }) => isActive ? 'nav-link nav-link--active' : 'nav-link'}>
                  Users
                </NavLink>
              ) : null}
            </nav>
            <div className="header-divider" aria-hidden="true" />
            <ThemeToggle />
            <button
              className="button-secondary sign-out-button"
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      {logout.error ? <p className="page error" role="alert">{logout.error.message}</p> : null}
      <Outlet />
    </>
  )
}
