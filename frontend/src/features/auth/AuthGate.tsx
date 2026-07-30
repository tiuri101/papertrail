import { Navigate, Outlet } from 'react-router-dom'

import { ApiError } from '../../api/client'
import { setCsrfToken } from './session'
import { useSession } from './sessionQuery'

export function AuthGate() {
  const session = useSession()

  if (session.isLoading) return <main className="page"><p>Loading session…</p></main>
  if (session.error instanceof ApiError && session.error.status === 403) {
    setCsrfToken(null)
    return <Navigate to="/login" replace />
  }
  if (!session.data) return <main className="page"><p role="alert">The session could not be loaded.</p></main>
  return <Outlet />
}
