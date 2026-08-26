export interface AuditEvent {
  id: string
  createdAt: string
  actorUsername: string | null
  action: string
  entityType: string
  entityId: string | null
  summary: string
  metadata: Record<string, unknown>
}

/**
 * One page of a project's audit log. `total` counts every event matching the
 * request's filters, not just this page -- the audit log is append-only and
 * unbounded, so a view that shows a page has to be able to say how much of
 * the history that page is.
 */
export interface AuditEventPage {
  items: AuditEvent[]
  total: number
  hasMore: boolean
  /** Opaque; pass back as `cursor` for the next page. */
  nextCursor: string | null
}

/**
 * Every value present anywhere in the project's log. Filter dropdowns must be
 * built from this rather than from the loaded rows, or paging would silently
 * shrink the choices to whatever the current page happens to contain.
 */
export interface AuditFilterOptions {
  actions: string[]
  entityTypes: string[]
  actors: Array<{ id: string; name: string }>
}

export interface AuditQueryFilters {
  action: string
  entityType: string
  actorId: string
  search: string
}

export const EMPTY_AUDIT_FILTERS: AuditQueryFilters = {
  action: '',
  entityType: '',
  actorId: '',
  search: '',
}

export function auditQueryString(filters: AuditQueryFilters, limit: number, cursor: string | null): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor) params.set('cursor', cursor)
  if (filters.action) params.set('action', filters.action)
  if (filters.entityType) params.set('entityType', filters.entityType)
  if (filters.actorId) params.set('actorId', filters.actorId)
  if (filters.search.trim()) params.set('search', filters.search.trim())
  return params.toString()
}
