import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Page } from '../../components/Page'

import { ApiError } from '../../api/client'
import { setCsrfToken } from './session'
import { useSession } from './sessionQuery'

const CHANGE_PASSWORD_PATH = '/change-password'

export function AuthGate() {
  const session = useSession()
  const location = useLocation()

  if (session.isLoading) return <Page><p>Loading session…</p></Page>
  if (session.error instanceof ApiError && session.error.status === 403) {
    setCsrfToken(null)
    return <Navigate to="/login" replace />
  }
  if (!session.data) return <Page><p role="alert">The session could not be loaded.</p></Page>
  if (session.data.user.mustChangePassword && location.pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />
  }
  return <Outlet />
}
