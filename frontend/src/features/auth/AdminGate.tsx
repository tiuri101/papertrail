import { Navigate, Outlet } from 'react-router-dom'

import { useSession } from './sessionQuery'

export function AdminGate() {
  const session = useSession()

  if (!session.data?.user.isAdmin) return <Navigate to="/" replace />
  return <Outlet />
}
