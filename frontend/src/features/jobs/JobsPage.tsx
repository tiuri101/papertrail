import { Fragment, useMemo, useState } from 'react'
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

interface JobErrorReport {
  jobId: string
  jobType: string
  jobLabel: string
  affectedStage: string
  projectId: string | null
  projectName: string | null
  projectStage: string | null
  attempt: number
  maxAttempts: number
  queuedAt: string
  startedAt: string | null
  failedAt: string | null
  context: Record<string, string | number | boolean | null>
  errorType: string | null
  errorMessage: string | null
  errorDetails: string | null
}

function JobFailureDetails({ job }: { job: BackgroundJob }) {
  const [visible, setVisible] = useState(false)
  const report = useQuery({
    queryKey: ['job-error', job.id],
    queryFn: () => apiRequest<JobErrorReport>(`/api/v1/jobs/${job.id}/error`),
    enabled: visible,
    staleTime: Infinity,
  })
  const diagnosticText = report.data?.errorDetails
    ?? report.data?.errorMessage
    ?? job.errorMessage
    ?? 'No diagnostic information was captured for this job.'
  const reportContext = report.data ? [
    `Job: ${report.data.jobLabel}`,
    `Job type: ${report.data.jobType}`,
    `Job ID: ${report.data.jobId}`,
    `Affected stage: ${report.data.affectedStage}`,
    `Project: ${report.data.projectName ?? 'System-wide'}`,
    `Project ID: ${report.data.projectId ?? 'Not applicable'}`,
    `Project stage: ${report.data.projectStage ?? 'Not applicable'}`,
    `Attempt: ${report.data.attempt} of ${report.data.maxAttempts}`,
    `Queued: ${formatDate(report.data.queuedAt)}`,
    `Started: ${formatDate(report.data.startedAt)}`,
    `Failed: ${formatDate(report.data.failedAt)}`,
    ...Object.entries(report.data.context).map(([key, value]) => `${key}: ${String(value)}`),
    `Error type: ${report.data.errorType ?? 'Unknown'}`,
    `Error message: ${report.data.errorMessage ?? 'Unknown error'}`,
  ] : [
    `Job: ${job.jobType}`,
    `Job ID: ${job.id}`,
    `Status: ${job.status}`,
  ]
  const downloadText = [...reportContext, '', 'Traceback:', diagnosticText].join('\n')

  return (
    <div className="job-failure">
      <span className="error" role="alert">{job.errorMessage}</span>
      <button
        type="button"
        className="link-button"
        aria-expanded={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? 'Hide error details' : 'View error details'}
      </button>
      {visible ? (
        <div className="job-error-report">
          {report.isLoading ? <p>Loading diagnostic report…</p> : null}
          {report.error ? <p className="error" role="alert">{report.error.message}</p> : null}
          {report.data ? (
            <>
              <strong>Failure context</strong>
              <dl className="job-error-context">
                <dt>Job</dt>
                <dd>{report.data.jobLabel} <code>{report.data.jobType}</code></dd>
                <dt>Job ID</dt><dd><code>{report.data.jobId}</code></dd>
                <dt>Affected stage</dt><dd>{report.data.affectedStage}</dd>
                <dt>Project</dt>
                <dd>{report.data.projectName ?? 'System-wide'}{report.data.projectId ? ` (${report.data.projectId})` : ''}</dd>
                <dt>Current project stage</dt><dd>{report.data.projectStage ?? 'Not applicable'}</dd>
                <dt>Attempt</dt><dd>{report.data.attempt} of {report.data.maxAttempts}</dd>
                <dt>Queued</dt><dd>{formatDate(report.data.queuedAt)}</dd>
                <dt>Started</dt><dd>{formatDate(report.data.startedAt)}</dd>
                <dt>Failed</dt><dd>{formatDate(report.data.failedAt)}</dd>
                {Object.entries(report.data.context).map(([key, value]) => (
                  <Fragment key={key}><dt>{key}</dt><dd>{String(value)}</dd></Fragment>
                ))}
                <dt>Error type</dt><dd>{report.data.errorType ?? 'Unknown'}</dd>
              </dl>
              <strong>Traceback</strong>
              <pre>{diagnosticText}</pre>
              <a
                download={`job-${job.id}-error.txt`}
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(downloadText)}`}
              >
                Download error report
              </a>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
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
                    {job.errorMessage ? <JobFailureDetails job={job} /> : null}
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
