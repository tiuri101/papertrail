import { tableBaseClass, tableScrollClass, toolbarClass } from '../../components/layoutStyles'
import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Page } from '../../components/Page'
import { CountPill } from '../../components/CountPill'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { SortableColumnHeader } from '../../components/SortableColumnHeader'
import { InfoTooltip } from '../../components/Tooltip'
import { useProjectManageState } from '../../hooks/useCanManageProject'
import {
  auditQueryString,
  EMPTY_AUDIT_FILTERS,
  type AuditEvent,
  type AuditEventPage,
  type AuditFilterOptions,
  type AuditQueryFilters,
} from './types'

type SortKey = 'createdAt' | 'actorUsername' | 'action' | 'entityType' | 'summary'
type SortDirection = 'asc' | 'desc'

const PAGE_SIZE = 100

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

  // The dropdowns describe the whole log, not the loaded page.
  const filterOptions = useQuery({
    queryKey: ['audit-filters', projectId],
    queryFn: () => apiRequest<AuditFilterOptions>(`/api/v1/projects/${projectId}/audit/filters`),
    enabled: Boolean(projectId) && canManage,
  })

  const [filters, setFilters] = useState<AuditQueryFilters>(EMPTY_AUDIT_FILTERS)
  const [searchInput, setSearchInput] = useState('')

  // Free-text search runs server-side over the whole history, so it goes over
  // the wire; a short settle keeps it to one request per pause in typing
  // rather than one per keystroke.
  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((current) => (
        current.search === searchInput ? current : { ...current, search: searchInput }
      )),
      250,
    )
    return () => clearTimeout(timer)
  }, [searchInput])

  // Filters are part of the query key, so changing one starts a fresh first
  // page instead of appending to results gathered under the previous filter.
  const events = useInfiniteQuery({
    queryKey: ['audit', projectId, filters],
    queryFn: ({ pageParam }) => apiRequest<AuditEventPage>(
      `/api/v1/projects/${projectId}/audit?${auditQueryString(filters, PAGE_SIZE, pageParam)}`,
    ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(projectId) && canManage,
  })

  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')

  const loadedEvents = useMemo(
    () => (events.data?.pages ?? []).flatMap((page) => page.items),
    [events.data],
  )
  const total = events.data?.pages[0]?.total ?? 0
  const filtered = filters.action !== '' || filters.entityType !== ''
    || filters.actorId !== '' || filters.search.trim() !== ''

  const sortedEvents = useMemo(() => {
    const result = [...loadedEvents]
    result.sort((left, right) => {
      const leftValue = sortValue(left, sortKey)
      const rightValue = sortValue(right, sortKey)
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base' })
      return sortDirection === 'asc' ? comparison : -comparison
    })
    return result
  }, [loadedEvents, sortDirection, sortKey])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection(key === 'createdAt' ? 'desc' : 'asc')
    }
  }

  const updateFilter = (patch: Partial<AuditQueryFilters>) => {
    setFilters((current) => ({ ...current, ...patch }))
  }

  if (canManageLoading) {
    return <Page><p>Loading…</p></Page>
  }
  if (!canManage) {
    return (
      <Page>
        <h1>Audit Log</h1>
        <p className="text-danger" role="alert">
          Only the project owner or an administrator can view the audit log.
        </p>
      </Page>
    )
  }

  const hasAnyEvents = total > 0 || loadedEvents.length > 0 || filtered

  return (
    <Page>
      <h1>Audit Log</h1>
      <p className="text-text-muted">A record of significant actions taken on this project, most recent first.</p>
      {events.error ? <p className="text-danger" role="alert">{events.error.message}</p> : null}
      {events.isLoading ? <p>Loading…</p> : null}
      {events.isSuccess && !hasAnyEvents ? <p>No audit events recorded yet.</p> : null}
      {hasAnyEvents ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm font-semibold text-text-secondary">
            Action
            <Select value={filters.action} onChange={(event) => updateFilter({ action: event.target.value })}>
              <option value="">All</option>
              {(filterOptions.data?.actions ?? []).map((action) => (
                <option key={action} value={action}>{action}</option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-text-secondary">
            Entity
            <Select value={filters.entityType} onChange={(event) => updateFilter({ entityType: event.target.value })}>
              <option value="">All</option>
              {(filterOptions.data?.entityTypes ?? []).map((entityType) => (
                <option key={entityType} value={entityType}>{entityType}</option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-text-secondary">
            User
            <Select value={filters.actorId} onChange={(event) => updateFilter({ actorId: event.target.value })}>
              <option value="">All</option>
              {(filterOptions.data?.actors ?? []).map((actor) => (
                <option key={actor.id} value={actor.id}>{actor.name}</option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-text-secondary">
            Search
            <Input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Filter by summary"
            />
          </label>
        </div>
      ) : null}
      {hasAnyEvents && !events.isLoading ? (
        <CountPill count={loadedEvents.length}>
          {loadedEvents.length === total
            ? `${filtered ? 'matching ' : ''}audit event${total === 1 ? '' : 's'}`
            : `of ${total} ${filtered ? 'matching ' : ''}audit events loaded`}
        </CountPill>
      ) : null}
      {sortedEvents.length ? (
        <div className={tableScrollClass}>
          <table className={tableBaseClass}>
            <caption className="sr-only">Audit events</caption>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <SortableColumnHeader
                    key={column.key}
                    label={column.label}
                    active={sortKey === column.key}
                    direction={sortDirection}
                    onSort={() => toggleSort(column.key)}
                    accessory={COLUMN_HELP[column.key] ? (
                      <InfoTooltip text={COLUMN_HELP[column.key]!} label={`About ${column.label}`} placement="bottom" />
                    ) : null}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedEvents.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.createdAt).toLocaleString()}</td>
                  <td>{event.actorUsername ?? <span className="text-text-muted">System</span>}</td>
                  <td>{event.action}</td>
                  <td>{event.entityType}{event.entityId ? ` (${event.entityId})` : ''}</td>
                  <td>{event.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {events.hasNextPage ? (
        <div className={toolbarClass}>
          <Button
            type="button"
            variant="secondary"
            onClick={() => events.fetchNextPage()}
            disabled={events.isFetchingNextPage}
          >
            {events.isFetchingNextPage ? 'Loading…' : 'Load More Events'}
          </Button>
          {/* Column sorting can only ever reorder what has been loaded, so
              say so while more of the history is still unread. */}
          <p className="text-text-muted m-0">
            Showing the {loadedEvents.length} most recent of {total} events. Sorting applies to these.
          </p>
        </div>
      ) : null}
      {events.isSuccess && hasAnyEvents && sortedEvents.length === 0 ? (
        <p className="text-text-muted">No audit events match your filters.</p>
      ) : null}
    </Page>
  )
}
