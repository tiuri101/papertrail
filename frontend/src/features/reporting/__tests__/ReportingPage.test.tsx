import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReportingPage } from '../ReportingPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ReportingPage', () => {
  it('shows PRISMA counts and generates a downloadable export', async () => {
    const artifacts: Array<{ id: string; type: string; filename: string; createdAt: string }> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/prisma')) return jsonResponse({ recordsScreened: 120, reportsIncluded: 18 })
      if (path.endsWith('/exports') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const artifact = { id: 'artifact-1', type: body.exportType, filename: 'papertrail.xlsx', createdAt: '2026-07-30T08:00:00Z' }
        artifacts.push(artifact)
        return jsonResponse(artifact, 202)
      }
      return jsonResponse(artifacts)
    })
    renderWithProviders(<ReportingPage />, { route: '/projects/p1/reporting', path: '/projects/:projectId/reporting' })

    expect(await screen.findByText(/"recordsScreened": 120/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Generate Excel workbook' }))

    const link = await screen.findByRole('link', { name: 'papertrail.xlsx' })
    expect(link).toHaveAttribute('href', '/api/v1/projects/p1/exports/artifact-1/download')
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({ exportType: 'xlsx', scope: 'included' })
  })

  it('shows exports as generating, then lists them once the export job finishes', async () => {
    let exportStatus = 'queued'
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/prisma')) return jsonResponse({})
      if (path.endsWith('/exports') && init?.method === 'POST') {
        return jsonResponse({ jobId: 'job-9' }, 202)
      }
      if (path.endsWith('/jobs')) {
        return jsonResponse([
          {
            id: 'job-9',
            jobType: 'generate_export',
            status: exportStatus,
            progressCurrent: 0,
            progressTotal: 0,
            progressMessage: null,
            errorMessage: null,
            createdAt: '2026-07-30T08:00:00Z',
            completedAt: null,
          },
        ])
      }
      if (path.endsWith('/exports')) {
        return jsonResponse(
          exportStatus === 'completed'
            ? [{ id: 'artifact-1', type: 'xlsx', filename: 'papertrail.xlsx', createdAt: '2026-07-30T08:01:00Z' }]
            : [],
        )
      }
      return jsonResponse([])
    })
    const { queryClient } = renderWithProviders(<ReportingPage />, { route: '/projects/p1/reporting', path: '/projects/:projectId/reporting' })
    await screen.findByRole('heading', { name: 'Reporting and exports' })

    fireEvent.click(screen.getByRole('button', { name: 'Generate Excel workbook' }))
    expect(await screen.findByText('Generating export…')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'papertrail.xlsx' })).not.toBeInTheDocument()

    exportStatus = 'completed'
    await queryClient.invalidateQueries({ queryKey: ['jobs', 'p1'] })

    expect(await screen.findByRole('link', { name: 'papertrail.xlsx' })).toBeInTheDocument()
    expect(screen.queryByText('Generating export…')).not.toBeInTheDocument()
  })

  it('offers all required export families', async () => {
    mockFetch(async (input) => String(input).endsWith('/prisma') ? jsonResponse({}) : jsonResponse([]))
    renderWithProviders(<ReportingPage />, { route: '/projects/p1/reporting', path: '/projects/:projectId/reporting' })
    await screen.findByRole('heading', { name: 'Reporting and exports' })

    expect(screen.getByRole('button', { name: 'Generate PRISMA SVG' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate Excel workbook' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate PRISMA supporting tables' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate BibTeX' })).toBeInTheDocument()
  })
})
