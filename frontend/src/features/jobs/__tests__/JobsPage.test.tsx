import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { JobsPage } from '../JobsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

interface RawJob {
  id: string
  jobType: string
  status: string
  progressCurrent: number
  progressTotal: number
  progressMessage: string | null
  errorMessage: string | null
  createdAt: string
  completedAt: string | null
}

/**
 * Stand-in for `GET /projects/:id/jobs/page`: applies the same status/jobType
 * filtering, column sort and slicing the real endpoint does, so the tests
 * exercise the page's server-driven behaviour rather than a fixed payload.
 */
function jobPage(all: RawJob[], url: unknown) {
  const params = new URL(String(url), 'http://test').searchParams
  const status = params.get('status') ?? ''
  const jobType = params.get('jobType') ?? ''
  const sort = params.get('sort') ?? 'createdAt'
  const direction = params.get('direction') ?? 'desc'
  const page = Number(params.get('page') ?? '1')
  const pageSize = Number(params.get('pageSize') ?? '25')

  const filtered = all.filter(
    (job) => (!status || job.status === status) && (!jobType || job.jobType === jobType),
  )
  const dir = direction === 'asc' ? 1 : -1
  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'jobType') return a.jobType.localeCompare(b.jobType) * dir
    if (sort === 'status') return a.status.localeCompare(b.status) * dir
    return (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * dir
  })
  const start = (page - 1) * pageSize

  const statusCounts: Record<string, number> = {
    queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
  }
  for (const job of all) statusCounts[job.status] = (statusCounts[job.status] ?? 0) + 1

  return jsonResponse({
    items: sorted.slice(start, start + pageSize),
    total: filtered.length,
    projectTotal: all.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(filtered.length / pageSize)),
    hasMore: start + pageSize < filtered.length,
    statusCounts,
    jobTypes: [...new Set(all.map((job) => job.jobType))].sort(),
    failedIds: all.filter((job) => job.status === 'failed').map((job) => job.id),
  })
}

const COMPLETED_JOB: RawJob = {
  id: 'job-1',
  jobType: 'parse_import',
  status: 'completed',
  progressCurrent: 10,
  progressTotal: 10,
  progressMessage: null,
  errorMessage: null,
  createdAt: '2026-07-30T10:00:00Z',
  completedAt: '2026-07-30T10:00:05Z',
}

const FAILED_JOB: RawJob = {
  id: 'job-2',
  jobType: 'enrich_publication',
  status: 'failed',
  progressCurrent: 0,
  progressTotal: 0,
  progressMessage: null,
  errorMessage: 'Crossref request timed out',
  createdAt: '2026-07-30T11:00:00Z',
  completedAt: null,
}

const RUNNING_JOB: RawJob = {
  id: 'job-3',
  jobType: 'parse_import',
  status: 'running',
  progressCurrent: 3,
  progressTotal: 10,
  progressMessage: 'Parsing row 3',
  errorMessage: null,
  createdAt: '2026-07-30T12:00:00Z',
  completedAt: null,
}

const QUEUED_JOB: RawJob = {
  id: 'job-4',
  jobType: 'detect_duplicates',
  status: 'queued',
  progressCurrent: 0,
  progressTotal: 0,
  progressMessage: null,
  errorMessage: null,
  createdAt: '2026-07-30T12:05:00Z',
  completedAt: null,
}

describe('JobsPage', () => {
  it('lists jobs with their status and progress', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/jobs/job-2/error')) {
        return jsonResponse({
          jobId: 'job-2',
          jobType: 'enrich_publication',
          jobLabel: 'Enrich publication metadata',
          affectedStage: 'Publication metadata',
          projectId: 'p1',
          projectName: 'Immersive Review',
          projectStage: 'Title/abstract screening',
          attempt: 3,
          maxAttempts: 3,
          queuedAt: '2026-07-30T11:00:00Z',
          startedAt: '2026-07-30T11:00:02Z',
          failedAt: '2026-07-30T11:00:10Z',
          context: {
            'Publication ID': 'publication-1',
            Publication: 'Urban Data in VR',
          },
          errorType: 'TimeoutError',
          errorMessage: 'Crossref request timed out',
          errorDetails: 'Traceback (most recent call last):\nTimeoutError: Crossref request timed out',
        })
      }
      if (url.includes('/jobs/page')) return jobPage([COMPLETED_JOB, FAILED_JOB], input)
      return jsonResponse({ id: 'p1', canManage: false })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    const summary = await screen.findByRole('region', { name: 'Job status summary' })
    expect(within(summary).getByLabelText('1 completed job')).toBeInTheDocument()
    expect(within(summary).getByLabelText('1 failed job')).toBeInTheDocument()
    expect(within(summary).getByLabelText('0 running jobs')).toBeInTheDocument()
    expect(within(summary).getByLabelText('0 queued jobs')).toBeInTheDocument()
    expect(within(summary).getByLabelText('0 cancelled jobs')).toBeInTheDocument()

    const completedRow = await screen.findByRole('row', { name: /parse_import/ })
    expect(completedRow).toHaveTextContent('completed')
    expect(completedRow).toHaveTextContent('10 / 10')

    const failedRow = screen.getByRole('row', { name: /enrich_publication/ })
    expect(failedRow).toHaveTextContent('failed')
    expect(screen.getByText('Crossref request timed out')).toBeInTheDocument()
    fireEvent.click(within(failedRow).getByRole('button', { name: 'View error details' }))
    expect(await within(failedRow).findByText('Enrich publication metadata')).toBeInTheDocument()
    expect(within(failedRow).getByText('Publication metadata')).toBeInTheDocument()
    expect(within(failedRow).getByText('Title/abstract screening')).toBeInTheDocument()
    expect(within(failedRow).getByText('Urban Data in VR')).toBeInTheDocument()
    expect(within(failedRow).getByText('3 of 3')).toBeInTheDocument()
    expect(within(failedRow).getByText('TimeoutError')).toBeInTheDocument()
    expect(await within(failedRow).findByText(/TimeoutError: Crossref request timed out/)).toBeInTheDocument()
    expect(within(failedRow).getByRole('link', { name: 'Download error report' })).toHaveAttribute(
      'download',
      'job-job-2-error.txt',
    )
  })

  it('asks the server to re-sort when a column header is clicked', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.includes('/jobs/page')) return jobPage([COMPLETED_JOB, FAILED_JOB], input)
      return jsonResponse({ id: 'p1', canManage: false })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /parse_import/ })
    const queuedHeader = screen.getByRole('columnheader', { name: /Queued/ })
    expect(queuedHeader).toHaveAttribute('aria-sort', 'descending')
    // Default order: newest first.
    expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
      'enrich_publication',
      'parse_import',
    ])

    const jobHeader = screen.getByRole('columnheader', { name: /^Job/ })
    const jobSortButton = within(jobHeader).getByRole('button', { name: /^Job/ })
    fireEvent.click(jobSortButton)
    expect(jobHeader).toHaveAttribute('aria-sort', 'ascending')
    await waitFor(() => {
      expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
        'enrich_publication',
        'parse_import',
      ])
    })

    fireEvent.click(jobSortButton)
    expect(jobHeader).toHaveAttribute('aria-sort', 'descending')
    await waitFor(() => {
      expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
        'parse_import',
        'enrich_publication',
      ])
    })
    const sortedRequest = fetchMock.mock.calls
      .map(([callInput]) => String(callInput))
      .find((url) => url.includes('sort=jobType') && url.includes('direction=desc'))
    expect(sortedRequest).toBeTruthy()
  })

  it('paginates through the job list', async () => {
    const many: RawJob[] = Array.from({ length: 30 }, (_, index) => ({
      ...COMPLETED_JOB,
      id: `job-${index}`,
      jobType: `job_type_${String(index).padStart(2, '0')}`,
      createdAt: `2026-07-30T10:${String(index).padStart(2, '0')}:00Z`,
    }))
    mockFetch((input) => {
      const url = String(input)
      if (url.includes('/jobs/page')) return jobPage(many, input)
      return jsonResponse({ id: 'p1', canManage: false })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /job_type_29/ })
    expect(screen.getAllByRole('row').length).toBe(1 + 25) // header + first page
    const pager = screen.getByRole('navigation', { name: 'Job pages' })
    expect(within(pager).getByText('Page 1 of 2')).toBeInTheDocument()
    expect(within(pager).getByRole('button', { name: 'Previous' })).toBeDisabled()

    fireEvent.click(within(pager).getByRole('button', { name: 'Next' }))

    // The last page holds the five oldest jobs.
    await screen.findByRole('row', { name: /job_type_00/ })
    expect(screen.getAllByRole('row').length).toBe(1 + 5)
    expect(within(pager).getByText('Page 2 of 2')).toBeInTheDocument()
    expect(within(pager).getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it('shows an empty state when no jobs have run', async () => {
    mockFetch((input) => {
      if (String(input).includes('/jobs/page')) return jobPage([], input)
      return jsonResponse({ id: 'p1', canManage: false })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    expect(await screen.findByText('No background jobs have run for this project yet.')).toBeInTheDocument()
  })

  it('reflects a job finishing once fresh data arrives, as background polling would deliver', async () => {
    let status = 'running'
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.includes('/jobs/page')) {
        return jobPage([{
          ...COMPLETED_JOB,
          id: 'job-1',
          jobType: 'detect_duplicates',
          status,
          progressCurrent: 0,
          progressTotal: 0,
          completedAt: null,
        }], input)
      }
      return jsonResponse({ id: 'p1', canManage: false })
    })
    const { queryClient } = renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    expect(await screen.findByRole('row', { name: /detect_duplicates/ })).toHaveTextContent('running')
    expect(screen.getByLabelText('1 running job')).toBeInTheDocument()

    status = 'completed'
    await queryClient.invalidateQueries({ queryKey: ['jobs', 'p1'] })

    await waitFor(() => {
      expect(screen.getByRole('row', { name: /detect_duplicates/ })).toHaveTextContent('completed')
      expect(screen.getByLabelText('0 running jobs')).toBeInTheDocument()
      expect(screen.getByLabelText('1 completed job')).toBeInTheDocument()
    })
    const jobsCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/projects/p1/jobs/page'))
    expect(jobsCalls).toHaveLength(2)
  })

  it('filters jobs by status and job type through the server', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false })
      if (url.includes('/jobs/page')) return jobPage([COMPLETED_JOB, FAILED_JOB], input)
      return jsonResponse({ id: 'p1', canManage: false })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /parse_import/ })
    expect(screen.getByRole('row', { name: /enrich_publication/ })).toBeInTheDocument()

    const failedSummary = screen.getByRole('button', { name: '1 failed job' })
    fireEvent.click(failedSummary)
    expect(failedSummary).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Status')).toHaveValue('failed')
    await waitFor(() => {
      expect(screen.queryByRole('row', { name: /parse_import/ })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('row', { name: /enrich_publication/ })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Job type'), { target: { value: 'parse_import' } })
    await waitFor(() => {
      expect(screen.queryByRole('row', { name: /enrich_publication/ })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('row', { name: /parse_import/ })).toBeInTheDocument()
  })

  it('lets a manager restart a single failed job', async () => {
    let status = 'failed'
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/jobs/job-2/restart') && init?.method === 'POST') {
        status = 'queued'
        return jsonResponse({ id: 'job-2', jobType: 'enrich_publication', status: 'queued' })
      }
      if (url.includes('/jobs/page')) {
        return jobPage([{ ...FAILED_JOB, status, errorMessage: status === 'failed' ? 'Timed out' : null }], input)
      }
      return jsonResponse({ id: 'p1', canManage: true })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    const row = await screen.findByRole('row', { name: /enrich_publication/ })
    fireEvent.click(within(row).getByRole('button', { name: 'Restart' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([callInput, callInit]) => String(callInput).endsWith('/jobs/job-2/restart') && callInit?.method === 'POST')
      expect(call).toBeTruthy()
      expect(call?.[1]?.credentials).toBe('include')
    })
    await waitFor(() => {
      expect(screen.getByRole('row', { name: /enrich_publication/ })).toHaveTextContent('queued')
    })
  })

  it('lets a manager bulk-restart selected failed jobs', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/projects/p1/jobs/restart') && init?.method === 'POST') {
        return jsonResponse([{ id: 'job-2', jobType: 'enrich_publication', status: 'queued' }])
      }
      if (url.includes('/jobs/page')) return jobPage([COMPLETED_JOB, FAILED_JOB], input)
      return jsonResponse({ id: 'p1', canManage: true })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /parse_import/ })
    expect(screen.getByRole('button', { name: 'Restart Selected (0)' })).toBeDisabled()
    expect(screen.getByLabelText('Select parse_import job')).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Select enrich_publication job'))
    fireEvent.click(screen.getByRole('button', { name: 'Restart Selected (1)' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([callInput, callInit]) => String(callInput).endsWith('/projects/p1/jobs/restart') && callInit?.method === 'POST')
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ jobIds: ['job-2'] })
    })
  })

  it('hides restart controls from users without manage access', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false })
      if (url.includes('/jobs/page')) return jobPage([FAILED_JOB], input)
      return jsonResponse({ id: 'p1', canManage: false })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /enrich_publication/ })
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restart Selected/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restart All Failed/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel Running Jobs/ })).not.toBeInTheDocument()
  })

  it('lets a manager cancel all running and queued jobs after confirming', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.endsWith('/projects/p1/jobs/cancel') && init?.method === 'POST') {
        return jsonResponse([{ id: 'job-3', jobType: 'parse_import', status: 'cancelled' }])
      }
      if (url.includes('/jobs/page')) return jobPage([RUNNING_JOB, QUEUED_JOB, COMPLETED_JOB], input)
      return jsonResponse({ id: 'p1', canManage: true })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    const cancelButton = await screen.findByRole('button', { name: 'Cancel Running Jobs (2)' })
    fireEvent.click(cancelButton)

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Jobs' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([callInput, callInit]) =>
          String(callInput).endsWith('/projects/p1/jobs/cancel') && callInit?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(call?.[1]?.credentials).toBe('include')
    })
  })

  it('does not call the cancel endpoint when the confirmation is dismissed', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (url.includes('/jobs/page')) return jobPage([RUNNING_JOB], input)
      return jsonResponse({ id: 'p1', canManage: true })
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Running Jobs (1)' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep Running' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(
      fetchMock.mock.calls.some(([callInput]) => String(callInput).endsWith('/jobs/cancel')),
    ).toBe(false)
  })
})
