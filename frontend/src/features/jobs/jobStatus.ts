export interface BackgroundJob {
  id: string
  jobType: string
  status: string
  progressCurrent: number
  progressTotal: number
  progressMessage: string | null
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
  result?: Record<string, unknown> | null
}

/** One page of a project's background jobs — see `GET /projects/:id/jobs/page`. */
export interface JobPage {
  items: BackgroundJob[]
  total: number
  /** Jobs in the project regardless of the active filters. */
  projectTotal: number
  page: number
  pageSize: number
  pageCount: number
  hasMore: boolean
  /** Per-status counts across the whole project, not just this page. */
  statusCounts: Record<string, number>
  /** Distinct job types present in the project, sorted. */
  jobTypes: string[]
  /** Every failed job in the project, so "Restart all failed" spans pages. */
  failedIds: string[]
}

const ACTIVE_STATUSES = new Set(['queued', 'running'])

export function isJobActive(status: string): boolean {
  return ACTIVE_STATUSES.has(status)
}

export function hasActiveJob(jobs: unknown): boolean {
  return Array.isArray(jobs) && jobs.some((job) => isJobActive(job?.status))
}

export function findJob(jobs: unknown, jobId: string): BackgroundJob | undefined {
  return Array.isArray(jobs) ? jobs.find((job) => job?.id === jobId) : undefined
}
