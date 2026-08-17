import type { ClaimedJob, JobResult, JobStateUpdate, StoredConnection } from './types'

export class PapertrailAuthError extends Error {}

/**
 * All requests carry the agent's bearer token and go only to the paired
 * Papertrail server's own origin -- this is the single place that header is
 * attached, and it is never reused for publisher requests (those go through
 * retrieval/redirect-fetch.ts instead, which never sees this token).
 */
export class PapertrailClient {
  constructor(private readonly connection: StoredConnection) {}

  get serverUrl(): string {
    return this.connection.serverUrl
  }

  get displayName(): string {
    return this.connection.displayName
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.connection.serverUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${this.connection.agentToken}`,
      },
    })
    if (response.status === 401 || response.status === 403) {
      throw new PapertrailAuthError(
        'Papertrail rejected this browser helper\'s credentials. It may have been revoked. Pair again from Account Settings.',
      )
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
      throw new Error(body?.error?.message ?? `Papertrail request failed (HTTP ${response.status})`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  me(): Promise<{ id: string; displayName: string; extensionVersion: string | null }> {
    return this.request('/api/v1/browser-agent/me')
  }

  /** Cheap check for background polling (e.g. from chrome.alarms) -- does
   * not claim anything, just reports how many jobs are currently waiting. */
  async pendingJobsCount(): Promise<number> {
    const result = await this.request<{ pendingCount: number }>(
      '/api/v1/browser-agent/retrieval-jobs/pending-count',
    )
    return result.pendingCount
  }

  claimJob(): Promise<ClaimedJob | null> {
    return this.request('/api/v1/browser-agent/retrieval-jobs/claim', { method: 'POST' })
  }

  updateJobState(jobId: string, update: JobStateUpdate): Promise<JobResult> {
    return this.request(`/api/v1/browser-agent/retrieval-jobs/${jobId}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    })
  }

  uploadPdf(
    jobId: string,
    file: Blob,
    filename: string,
    sourceUrl: string,
    landingUrl: string | null,
  ): Promise<JobResult> {
    const form = new FormData()
    form.append('file', file, filename)
    form.append('sourceUrl', sourceUrl)
    if (landingUrl) form.append('landingUrl', landingUrl)
    return this.request(`/api/v1/browser-agent/retrieval-jobs/${jobId}/upload`, {
      method: 'POST',
      body: form,
    })
  }

  retryJob(jobId: string): Promise<JobResult> {
    return this.request(`/api/v1/browser-agent/retrieval-jobs/${jobId}/retry`, { method: 'POST' })
  }
}
