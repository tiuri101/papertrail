import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { JobsPage } from '../JobsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('JobsPage', () => {
  it('lists jobs with their status and progress', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/api/v1/jobs/job-2/error')) {
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
      return jsonResponse([
      {
        id: 'job-1',
        jobType: 'parse_import',
        status: 'completed',
        progressCurrent: 10,
        progressTotal: 10,
        progressMessage: null,
        errorMessage: null,
        createdAt: '2026-07-30T10:00:00Z',
        completedAt: '2026-07-30T10:00:05Z',
      },
      {
        id: 'job-2',
        jobType: 'enrich_publication',
        status: 'failed',
        progressCurrent: 0,
        progressTotal: 0,
        progressMessage: null,
        errorMessage: 'Crossref request timed out',
        createdAt: '2026-07-30T11:00:00Z',
        completedAt: null,
      },
      ])
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

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

  it('sorts the job table by any sortable column', async () => {
    mockFetch(() => jsonResponse([
      {
        id: 'job-1',
        jobType: 'parse_import',
        status: 'completed',
        progressCurrent: 10,
        progressTotal: 10,
        progressMessage: null,
        errorMessage: null,
        createdAt: '2026-07-30T10:00:00Z',
        completedAt: '2026-07-30T10:00:05Z',
      },
      {
        id: 'job-2',
        jobType: 'enrich_publication',
        status: 'failed',
        progressCurrent: 0,
        progressTotal: 0,
        progressMessage: null,
        errorMessage: 'Timed out',
        createdAt: '2026-07-30T11:00:00Z',
        completedAt: null,
      },
    ]))
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /parse_import/ })
    const queuedHeader = screen.getByRole('columnheader', { name: /Queued/ })
    expect(queuedHeader).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
      'enrich_publication',
      'parse_import',
    ])

    const jobHeader = screen.getByRole('columnheader', { name: /^Job/ })
    fireEvent.click(within(jobHeader).getByRole('button'))
    expect(jobHeader).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(within(jobHeader).getByRole('button'))
    expect(jobHeader).toHaveAttribute('aria-sort', 'descending')
    expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
      'parse_import',
      'enrich_publication',
    ])
  })

  it('shows an empty state when no jobs have run', async () => {
    mockFetch(() => jsonResponse([]))
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    expect(await screen.findByText('No background jobs have run for this project yet.')).toBeInTheDocument()
  })

  it('reflects a job finishing once fresh data arrives, as background polling would deliver', async () => {
    let status = 'running'
    const fetchMock = mockFetch(() => jsonResponse([
      {
        id: 'job-1',
        jobType: 'detect_duplicates',
        status,
        progressCurrent: 0,
        progressTotal: 0,
        progressMessage: null,
        errorMessage: null,
        createdAt: '2026-07-30T10:00:00Z',
        completedAt: null,
      },
    ]))
    const { queryClient } = renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    expect(await screen.findByRole('row', { name: /detect_duplicates/ })).toHaveTextContent('running')

    status = 'completed'
    await queryClient.invalidateQueries({ queryKey: ['jobs', 'p1'] })

    await waitFor(() => {
      expect(screen.getByRole('row', { name: /detect_duplicates/ })).toHaveTextContent('completed')
    })
    const jobsCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/projects/p1/jobs'))
    expect(jobsCalls).toHaveLength(2)
  })

  it('filters jobs by status and job type', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: false })
      return jsonResponse([
        {
          id: 'job-1',
          jobType: 'parse_import',
          status: 'completed',
          progressCurrent: 10,
          progressTotal: 10,
          progressMessage: null,
          errorMessage: null,
          createdAt: '2026-07-30T10:00:00Z',
          completedAt: '2026-07-30T10:00:05Z',
        },
        {
          id: 'job-2',
          jobType: 'enrich_publication',
          status: 'failed',
          progressCurrent: 0,
          progressTotal: 0,
          progressMessage: null,
          errorMessage: 'Timed out',
          createdAt: '2026-07-30T11:00:00Z',
          completedAt: null,
        },
      ])
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /parse_import/ })
    expect(screen.getByRole('row', { name: /enrich_publication/ })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } })
    expect(screen.queryByRole('row', { name: /parse_import/ })).not.toBeInTheDocument()
    expect(screen.getByRole('row', { name: /enrich_publication/ })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Job type'), { target: { value: 'parse_import' } })
    expect(screen.getByRole('row', { name: /parse_import/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /enrich_publication/ })).not.toBeInTheDocument()
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
      return jsonResponse([
        {
          id: 'job-2',
          jobType: 'enrich_publication',
          status,
          progressCurrent: 0,
          progressTotal: 0,
          progressMessage: null,
          errorMessage: status === 'failed' ? 'Timed out' : null,
          createdAt: '2026-07-30T11:00:00Z',
          completedAt: null,
        },
      ])
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
      return jsonResponse([
        {
          id: 'job-1',
          jobType: 'parse_import',
          status: 'completed',
          progressCurrent: 10,
          progressTotal: 10,
          progressMessage: null,
          errorMessage: null,
          createdAt: '2026-07-30T10:00:00Z',
          completedAt: '2026-07-30T10:00:05Z',
        },
        {
          id: 'job-2',
          jobType: 'enrich_publication',
          status: 'failed',
          progressCurrent: 0,
          progressTotal: 0,
          progressMessage: null,
          errorMessage: 'Timed out',
          createdAt: '2026-07-30T11:00:00Z',
          completedAt: null,
        },
      ])
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /parse_import/ })
    expect(screen.getByRole('button', { name: 'Restart Selected (0)' })).toBeDisabled()
    expect(screen.queryByLabelText('Select parse_import job')).not.toBeInTheDocument()

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
      return jsonResponse([
        {
          id: 'job-2',
          jobType: 'enrich_publication',
          status: 'failed',
          progressCurrent: 0,
          progressTotal: 0,
          progressMessage: null,
          errorMessage: 'Timed out',
          createdAt: '2026-07-30T11:00:00Z',
          completedAt: null,
        },
      ])
    })
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    await screen.findByRole('row', { name: /enrich_publication/ })
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restart Selected/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restart All Failed/ })).not.toBeInTheDocument()
  })
})
