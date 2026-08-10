import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { IconRestart } from '../../components/icons'
import { InfoTooltip } from '../../components/Tooltip'
import { useCanManageProject } from '../../hooks/useCanManageProject'
import { BackgroundJob, hasActiveJob } from './jobStatus'

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
]

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

const COLUMN_HELP: Partial<Record<SortKey, string>> = {
  jobType: 'The kind of automated task that ran, such as importing files, checking for duplicates, or extracting data. Background jobs run on their own without anyone triggering them by hand.',
  status: 'Queued: waiting for a worker to pick it up. Running: in progress. Completed: finished successfully. Failed: hit an error — use Restart to try again. Cancelled: stopped before it finished.',
}

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
  const queryClient = useQueryClient()
  const canManage = useCanManageProject(projectId)
  const [sortKey, setSortKey] = useState<SortKey>('createdAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [statusFilter, setStatusFilter] = useState('')
  const [jobTypeFilter, setJobTypeFilter] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 3000 : false),
  })

  const jobTypeOptions = useMemo(() => (
    Array.from(new Set((jobs.data ?? []).map((job) => job.jobType))).sort()
  ), [jobs.data])

  const filteredJobs = useMemo(() => (
    (jobs.data ?? []).filter((job) => (
      (!statusFilter || job.status === statusFilter)
      && (!jobTypeFilter || job.jobType === jobTypeFilter)
    ))
  ), [jobs.data, statusFilter, jobTypeFilter])

  const sortedJobs = useMemo(() => {
    const result = [...filteredJobs]
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
  }, [filteredJobs, sortDirection, sortKey])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection('asc')
    }
  }

  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const failedJobIds = useMemo(() => (
    (jobs.data ?? []).filter((job) => job.status === 'failed').map((job) => job.id)
  ), [jobs.data])

  const restartOne = useMutation({
    mutationFn: (jobId: string) => apiRequest<BackgroundJob>(
      `/api/v1/projects/${projectId}/jobs/${jobId}/restart`,
      { method: 'POST' },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs', projectId] })
    },
  })

  const restartMany = useMutation({
    mutationFn: (jobIds: string[]) => apiRequest<BackgroundJob[]>(
      `/api/v1/projects/${projectId}/jobs/restart`,
      { method: 'POST', body: JSON.stringify({ jobIds }) },
    ),
    onSuccess: () => {
      setSelectedIds(new Set())
      queryClient.invalidateQueries({ queryKey: ['jobs', projectId] })
    },
  })

  return (
    <main className="page">
      <h1>Jobs</h1>
      {jobs.error ? <p className="error" role="alert">{jobs.error.message}</p> : null}
      {restartOne.error ? <p className="error" role="alert">{restartOne.error.message}</p> : null}
      {restartMany.error ? <p className="error" role="alert">{restartMany.error.message}</p> : null}
      {jobs.isLoading ? <p>Loading…</p> : null}
      {jobs.data && jobs.data.length === 0 ? <p className="muted">No background jobs have run for this project yet.</p> : null}
      {jobs.data && jobs.data.length > 0 ? (
        <div className="toolbar">
          <label>
            Status
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              {STATUS_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            Job type
            <select value={jobTypeFilter} onChange={(event) => setJobTypeFilter(event.target.value)}>
              <option value="">All</option>
              {jobTypeOptions.map((jobType) => (
                <option key={jobType} value={jobType}>{jobType}</option>
              ))}
            </select>
          </label>
          {canManage ? (
            <>
              <button
                type="button"
                disabled={selectedIds.size === 0 || restartMany.isPending}
                onClick={() => restartMany.mutate(Array.from(selectedIds))}
              >
                <IconRestart />
                Restart Selected ({selectedIds.size})
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={failedJobIds.length === 0 || restartMany.isPending}
                onClick={() => restartMany.mutate(failedJobIds)}
              >
                Restart All Failed ({failedJobIds.length})
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {sortedJobs.length ? (
        <div className="table-scroll">
          <table>
            <caption className="visually-hidden">Background jobs</caption>
            <thead>
              <tr>
                {canManage ? <th scope="col">Select</th> : null}
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
                {canManage ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((job) => {
                const failed = job.status === 'failed'
                return (
                  <tr key={job.id}>
                    {canManage ? (
                      <td>
                        {failed ? (
                          <input
                            type="checkbox"
                            checked={selectedIds.has(job.id)}
                            onChange={() => toggleSelected(job.id)}
                            aria-label={`Select ${job.jobType} job`}
                          />
                        ) : null}
                      </td>
                    ) : null}
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
                    {canManage ? (
                      <td>
                        {failed ? (
                          <button
                            type="button"
                            className="button-secondary"
                            disabled={restartOne.isPending}
                            onClick={() => restartOne.mutate(job.id)}
                          >
                            Restart
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {jobs.data && jobs.data.length > 0 && sortedJobs.length === 0 ? (
        <p className="muted">No jobs match your filters.</p>
      ) : null}
    </main>
  )
}
