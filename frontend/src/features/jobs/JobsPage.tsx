import { tableCompactClass, tableScrollClass } from '../../components/layoutStyles'
import { Fragment, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Badge, type BadgeVariant } from '../../components/Badge'
import { Button, IconButton } from '../../components/Button'
import { CountPill } from '../../components/CountPill'
import { FormField } from '../../components/FormField'
import { IconRestart } from '../../components/icons'
import { Input } from '../../components/Input'
import { Page } from '../../components/Page'
import { Select } from '../../components/Select'
import { SortableColumnHeader } from '../../components/SortableColumnHeader'
import { InfoTooltip } from '../../components/Tooltip'
import { useCanManageProject } from '../../hooks/useCanManageProject'
import { cn } from '../../lib/cn'
import { AdministrationEyebrow } from '../projects/StageEyebrow'
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
  { key: 'jobType', label: 'Jobs' },
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

const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
  completed: 'success',
  running: 'primary',
  queued: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
}

const STATUS_SUMMARY_ITEMS = [
  { status: 'queued', label: 'Queued' },
  { status: 'running', label: 'Running' },
  { status: 'completed', label: 'Completed' },
  { status: 'failed', label: 'Failed' },
  { status: 'cancelled', label: 'Cancelled' },
] as const

const STATUS_CARD_STYLES: Record<string, string> = {
  running: 'border-primary/35 bg-primary-container aria-pressed:ring-primary/50 [&_strong]:text-primary',
  queued: 'border-warning/35 bg-warning-container aria-pressed:ring-warning/50 [&_strong]:text-warning',
  completed: 'border-success/35 bg-success-container aria-pressed:ring-success/50 [&_strong]:text-success',
  failed: 'border-danger/35 bg-danger-container aria-pressed:ring-danger/50 [&_strong]:text-danger',
  cancelled: 'border-border bg-bg-elevated aria-pressed:ring-border-strong/60 [&_strong]:text-text',
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
    <div className="grid gap-2">
      <span className="text-danger" role="alert">{job.errorMessage}</span>
      <Button
        type="button"
        variant="text"
        aria-expanded={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? 'Hide error details' : 'View error details'}
      </Button>
      {visible ? (
        <div className="rounded-md border border-danger/30 bg-danger-container p-4">
          {report.isLoading ? <p>Loading diagnostic report…</p> : null}
          {report.error ? <p className="text-danger" role="alert">{report.error.message}</p> : null}
          {report.data ? (
            <>
              <strong>Failure context</strong>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 [&_dd]:m-0 [&_dd]:overflow-wrap-anywhere [&_dt]:font-semibold [&_dt]:text-text-muted">
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
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-sm bg-bg-elevated p-3 text-xs">{diagnosticText}</pre>
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

  const jobStatusCounts = useMemo(() => (
    STATUS_SUMMARY_ITEMS.map((item) => ({
      ...item,
      count: (jobs.data ?? []).filter((job) => job.status === item.status).length,
    }))
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
  const allFailedSelected = failedJobIds.length > 0
    && failedJobIds.every((id) => selectedIds.has(id))

  const toggleAllFailed = () => setSelectedIds((current) => {
    const next = new Set(current)
    if (allFailedSelected) failedJobIds.forEach((id) => next.delete(id))
    else failedJobIds.forEach((id) => next.add(id))
    return next
  })

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
    <Page>
      <AdministrationEyebrow />
      <h1>Jobs</h1>
      <p className="text-text-muted">
        Background tasks for this project, such as imports, duplicate detection, and LLM-assisted
        extraction.
      </p>
      {jobs.error ? <p className="text-danger" role="alert">{jobs.error.message}</p> : null}
      {restartOne.error ? <p className="text-danger" role="alert">{restartOne.error.message}</p> : null}
      {restartMany.error ? <p className="text-danger" role="alert">{restartMany.error.message}</p> : null}
      {jobs.isLoading ? <p>Loading…</p> : null}
      {jobs.data ? (
        <CountPill count={sortedJobs.length}>
          {statusFilter || jobTypeFilter
            ? `of ${jobs.data.length} jobs match your filters`
            : `job${jobs.data.length === 1 ? '' : 's'}`}
        </CountPill>
      ) : null}
      {jobs.data && jobs.data.length === 0 ? <p className="text-text-muted">No background jobs have run for this project yet.</p> : null}
      {jobs.data && jobs.data.length > 0 ? (
        <section className="grid grid-cols-2 gap-3 min-[681px]:grid-cols-5" aria-label="Job status summary">
          {jobStatusCounts.map(({ status, label, count }) => (
            <button
              type="button"
              key={status}
              className={cn(
                'grid min-h-20 cursor-pointer gap-1 rounded-md border bg-none p-3 text-left shadow-none transition-[filter,background-color] hover:brightness-110 aria-pressed:ring-2 [&_strong]:text-xl [&_span]:text-xs [&_span]:font-semibold [&_span]:text-text-muted',
                STATUS_CARD_STYLES[status] ?? STATUS_CARD_STYLES.cancelled,
              )}
              aria-label={`${count} ${status} job${count === 1 ? '' : 's'}`}
              aria-pressed={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              <strong>{count}</strong>
              <span>{label}</span>
            </button>
          ))}
        </section>
      ) : null}
      {jobs.data && jobs.data.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3">
          <FormField label="Status">
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              {STATUS_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </FormField>
          <FormField label="Job type">
            <Select value={jobTypeFilter} onChange={(event) => setJobTypeFilter(event.target.value)}>
              <option value="">All</option>
              {jobTypeOptions.map((jobType) => (
                <option key={jobType} value={jobType}>{jobType}</option>
              ))}
            </Select>
          </FormField>
          {canManage ? (
            <>
              <Button
                type="button"
                disabled={selectedIds.size === 0 || restartMany.isPending}
                onClick={() => restartMany.mutate(Array.from(selectedIds))}
              >
                <IconRestart />
                Restart Selected ({selectedIds.size})
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={failedJobIds.length === 0 || restartMany.isPending}
                onClick={() => restartMany.mutate(failedJobIds)}
              >
                Restart All Failed ({failedJobIds.length})
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {sortedJobs.length ? (
        <div className={tableScrollClass}>
          <table className={`${tableCompactClass} jobs-table`}>
            <caption className="sr-only">Background jobs</caption>
            <thead>
              <tr>
                {canManage ? (
                  <th scope="col" className="w-10">
                    <Input
                      type="checkbox"
                      checked={allFailedSelected}
                      onChange={toggleAllFailed}
                      disabled={failedJobIds.length === 0}
                      aria-label="Select all failed jobs"
                    />
                  </th>
                ) : null}
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
                {canManage ? <th scope="col"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {sortedJobs.map((job) => {
                const failed = job.status === 'failed'
                return (
                  <tr key={job.id}>
                    {canManage ? (
                      <td>
                        <Input
                          type="checkbox"
                          checked={selectedIds.has(job.id)}
                          onChange={() => toggleSelected(job.id)}
                          disabled={!failed}
                          aria-label={`Select ${job.jobType} job`}
                          title={failed ? 'Select this failed job' : 'Only failed jobs can be restarted'}
                        />
                      </td>
                    ) : null}
                    <th scope="row" className="min-w-40">{job.jobType}</th>
                    <td>
                      <Badge variant={STATUS_BADGE_VARIANT[job.status] ?? 'neutral'} className="capitalize">
                        {job.status}
                      </Badge>
                    </td>
                    <td>
                      {job.progressTotal ? (
                        <span className="grid min-w-28 gap-1.5">
                          <span className="text-xs font-semibold text-text-secondary">{job.progressCurrent} / {job.progressTotal}</span>
                          {job.status === 'running' ? (
                            <span className="h-1.5 overflow-hidden rounded-full bg-surface-active">
                              <span
                                className="block h-full rounded-full bg-primary transition-[width] duration-200"
                                style={{ width: `${Math.min(100, (job.progressCurrent / job.progressTotal) * 100)}%` }}
                              />
                            </span>
                          ) : null}
                        </span>
                      ) : '—'}
                    </td>
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
                          <IconButton
                            variant="secondary"
                            size="sm"
                            className="rounded-full"
                            disabled={restartOne.isPending}
                            onClick={() => restartOne.mutate(job.id)}
                            aria-label="Restart"
                            title="Restart job"
                          >
                            <IconRestart />
                          </IconButton>
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
        <p className="text-text-muted">No jobs match your filters.</p>
      ) : null}
    </Page>
  )
}
