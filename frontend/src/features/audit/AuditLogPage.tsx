import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { useProjectManageState } from '../../hooks/useCanManageProject'

interface AuditEvent {
  id: string
  createdAt: string
  actorUsername: string | null
  action: string
  entityType: string
  entityId: string | null
  summary: string
  metadata: Record<string, unknown>
}

export function AuditLogPage() {
  const { projectId = '' } = useParams()
  const { canManage, isLoading: canManageLoading } = useProjectManageState(projectId)
  const events = useQuery({
    queryKey: ['audit', projectId],
    queryFn: () => apiRequest<AuditEvent[]>(
      `/api/v1/projects/${projectId}/audit`,
    ),
    enabled: Boolean(projectId) && canManage,
  })

  if (canManageLoading) {
    return <main className="page"><p>Loading…</p></main>
  }
  if (!canManage) {
    return (
      <main className="page">
        <h1>Audit Log</h1>
        <p className="error" role="alert">
          Only the project owner or an administrator can view the audit log.
        </p>
      </main>
    )
  }

  return (
    <main className="page">
      <h1>Audit Log</h1>
      <p className="muted">A record of significant actions taken on this project, most recent first.</p>
      {events.error ? <p className="error" role="alert">{events.error.message}</p> : null}
      {events.isLoading ? <p>Loading…</p> : null}
      {events.data && events.data.length === 0 ? <p>No audit events recorded yet.</p> : null}
      {events.data && events.data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">User</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">Summary</th>
            </tr>
          </thead>
          <tbody>
            {events.data.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.createdAt).toLocaleString()}</td>
                <td>{event.actorUsername ?? <span className="muted">System</span>}</td>
                <td>{event.action}</td>
                <td>{event.entityType}{event.entityId ? ` (${event.entityId})` : ''}</td>
                <td>{event.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
  )
}
