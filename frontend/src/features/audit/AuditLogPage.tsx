import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { InfoTooltip } from '../../components/Tooltip'
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

type SortKey = 'createdAt' | 'actorUsername' | 'action' | 'entityType' | 'summary'
type SortDirection = 'asc' | 'desc'

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'createdAt', label: 'Timestamp' },
  { key: 'actorUsername', label: 'User' },
  { key: 'action', label: 'Action' },
  { key: 'entityType', label: 'Entity' },
  { key: 'summary', label: 'Summary' },
]

const COLUMN_HELP: Partial<Record<SortKey, string>> = {
  action: 'The internal event code recorded for this change, in the form "area.event" (for example, project.created). The Summary column explains it in plain language.',
  entityType: 'The kind of record the action was performed on, such as a project, publication, or user. The ID in parentheses, if shown, identifies the specific record.',
}

function sortValue(event: AuditEvent, key: SortKey): string | number {
  if (key === 'createdAt') return Date.parse(event.createdAt)
  if (key === 'actorUsername') return event.actorUsername ?? ''
  if (key === 'entityType') return event.entityId ? `${event.entityType} (${event.entityId})` : event.entityType
  return event[key]
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

  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [actionFilter, setActionFilter] = useState('')
  const [entityTypeFilter, setEntityTypeFilter] = useState('')
  const [actorFilter, setActorFilter] = useState('')
  const [searchText, setSearchText] = useState('')

  const actionOptions = useMemo(() => (
    Array.from(new Set((events.data ?? []).map((event) => event.action))).sort()
  ), [events.data])
  const entityTypeOptions = useMemo(() => (
    Array.from(new Set((events.data ?? []).map((event) => event.entityType))).sort()
  ), [events.data])
  const actorOptions = useMemo(() => (
    Array.from(new Set((events.data ?? []).map((event) => event.actorUsername ?? 'System'))).sort()
  ), [events.data])

  const filteredEvents = useMemo(() => {
    const search = searchText.trim().toLowerCase()
    return (events.data ?? []).filter((event) => (
      (!actionFilter || event.action === actionFilter)
      && (!entityTypeFilter || event.entityType === entityTypeFilter)
      && (!actorFilter || (event.actorUsername ?? 'System') === actorFilter)
      && (!search || event.summary.toLowerCase().includes(search))
    ))
  }, [events.data, actionFilter, entityTypeFilter, actorFilter, searchText])

  const sortedEvents = useMemo(() => {
    const result = [...filteredEvents]
    result.sort((left, right) => {
      const leftValue = sortValue(left, sortKey)
      const rightValue = sortValue(right, sortKey)
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base' })
      return sortDirection === 'asc' ? comparison : -comparison
    })
    return result
  }, [filteredEvents, sortDirection, sortKey])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection(key === 'createdAt' ? 'desc' : 'asc')
    }
  }

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
        <div className="toolbar">
          <label>
            Action
            <select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)}>
              <option value="">All</option>
              {actionOptions.map((action) => (
                <option key={action} value={action}>{action}</option>
              ))}
            </select>
          </label>
          <label>
            Entity
            <select value={entityTypeFilter} onChange={(event) => setEntityTypeFilter(event.target.value)}>
              <option value="">All</option>
              {entityTypeOptions.map((entityType) => (
                <option key={entityType} value={entityType}>{entityType}</option>
              ))}
            </select>
          </label>
          <label>
            User
            <select value={actorFilter} onChange={(event) => setActorFilter(event.target.value)}>
              <option value="">All</option>
              {actorOptions.map((actor) => (
                <option key={actor} value={actor}>{actor}</option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input
              type="search"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Filter by summary"
            />
          </label>
        </div>
      ) : null}
      {sortedEvents.length ? (
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Audit events</caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const active = sortKey === column.key
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <button type="button" className="link-button" onClick={() => toggleSort(column.key)}>
                        {column.label}{active ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                      </button>
                      {COLUMN_HELP[column.key] ? (
                        <InfoTooltip text={COLUMN_HELP[column.key]!} label={`About ${column.label}`} placement="bottom" />
                      ) : null}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sortedEvents.map((event) => (
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
        </div>
      ) : null}
      {events.data && events.data.length > 0 && sortedEvents.length === 0 ? (
        <p className="muted">No audit events match your filters.</p>
      ) : null}
    </main>
  )
}
