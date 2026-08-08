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
