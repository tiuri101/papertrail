import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { BackgroundJob, hasActiveJob } from './jobStatus'

type SortKey = 'jobType' | 'status' | 'progress' | 'message' | 'createdAt' | 'completedAt'
type SortDirection = 'asc' | 'desc'

const COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: 'jobType', label: 'Job' },
  { key: 'status', label: 'Status' },
  { key: 'progress', label: 'Progress' },
  { key: 'message', label: 'Message' },
  { key: 'createdAt', label: 'Queued' },
  { key: 'completedAt', label: 'Completed' },
]

function sortValue(job: BackgroundJob, key: SortKey): string | number | null {
  if (key === 'progress') {
    return job.progressTotal ? job.progressCurrent / job.progressTotal : null
  }
  if (key === 'message') return job.errorMessage ?? job.progressMessage ?? ''
  if (key === 'createdAt') return Date.parse(job.createdAt)
  if (key === 'completedAt') return job.completedAt ? Date.parse(job.completedAt) : null
  return job[key]
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—'
}

export function JobsPage() {
  const { projectId = '' } = useParams()
  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 3000 : false),
  })

  const sortedJobs = useMemo(() => {
    const result = [...(jobs.data ?? [])]
    result.sort((left, right) => {
      const leftValue = sortValue(left, sortKey)
      const rightValue = sortValue(right, sortKey)
      if (leftValue === null) return rightValue === null ? 0 : 1
      if (rightValue === null) return -1
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base' })
      return sortDirection === 'asc' ? comparison : -comparison
    })
    return result
  }, [jobs.data, sortDirection, sortKey])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection('asc')
    }
  }

  return (
    <main className="page">
      <h1>Jobs</h1>
      {jobs.error ? <p className="error" role="alert">{jobs.error.message}</p> : null}
      {jobs.isLoading ? <p>Loading…</p> : null}
      {jobs.data && jobs.data.length === 0 ? <p className="muted">No background jobs have run for this project yet.</p> : null}
      {sortedJobs.length ? (
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Background jobs</caption>
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
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((job) => (
                <tr key={job.id}>
                  <th scope="row">{job.jobType}</th>
                  <td>{job.status}</td>
                  <td>{job.progressTotal ? `${job.progressCurrent} / ${job.progressTotal}` : '—'}</td>
                  <td>
                    {job.errorMessage ? <span className="error" role="alert">{job.errorMessage}</span> : null}
                    {!job.errorMessage && job.progressMessage ? job.progressMessage : null}
                    {!job.errorMessage && !job.progressMessage ? '—' : null}
                  </td>
                  <td>{formatDate(job.createdAt)}</td>
                  <td>{formatDate(job.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  )
}
