import { screen } from '@testing-library/react'
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

    const completedRow = (await screen.findByText('parse_import')).closest('li')
    expect(completedRow).toHaveTextContent('completed')
    expect(completedRow).toHaveTextContent('(10/10)')

    const failedRow = screen.getByText('enrich_publication').closest('li')
    expect(failedRow).toHaveTextContent('failed')
    expect(screen.getByText('Crossref request timed out')).toBeInTheDocument()
  })

  it('shows an empty state when no jobs have run', async () => {
    mockFetch(() => jsonResponse([]))
    renderWithProviders(<JobsPage />, { route: '/projects/p1/jobs', path: '/projects/:projectId/jobs' })

    expect(await screen.findByText('No background jobs have run for this project yet.')).toBeInTheDocument()
  })
})
