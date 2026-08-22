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
