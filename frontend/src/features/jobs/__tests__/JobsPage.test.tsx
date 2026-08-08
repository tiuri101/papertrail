import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { JobsPage } from '../JobsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('JobsPage', () => {
  it('lists jobs with their status and progress', async () => {
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
        errorMessage: 'Crossref request timed out',
        createdAt: '2026-07-30T11:00:00Z',
        completedAt: null,
      },
    ]))
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    const completedRow = await screen.findByRole('row', { name: /parse_import/ })
    expect(completedRow).toHaveTextContent('completed')
    expect(completedRow).toHaveTextContent('10 / 10')

    const failedRow = screen.getByRole('row', { name: /enrich_publication/ })
    expect(failedRow).toHaveTextContent('failed')
    expect(screen.getByText('Crossref request timed out')).toBeInTheDocument()
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
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
