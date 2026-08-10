import { fireEvent, screen, waitForElementToBeRemoved } from '@testing-library/react'
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

    const countLabel = await screen.findByText('Records Screened')
    expect(countLabel.parentElement).toHaveTextContent('120')
    fireEvent.click(screen.getByRole('button', { name: 'Generate Excel Workbook' }))

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
    await screen.findByRole('heading', { name: 'Reporting and Exports' })

    fireEvent.click(screen.getByRole('button', { name: 'Generate Excel Workbook' }))
    expect(await screen.findByText('Generating export…')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'papertrail.xlsx' })).not.toBeInTheDocument()

    exportStatus = 'completed'
    await queryClient.invalidateQueries({ queryKey: ['jobs', 'p1'] })

    expect(await screen.findByRole('link', { name: 'papertrail.xlsx' })).toBeInTheDocument()
    expect(screen.queryByText('Generating export…')).not.toBeInTheDocument()
  })

  it('deletes an export after confirmation', async () => {
    let artifacts = [{ id: 'artifact-1', type: 'xlsx', filename: 'Review_2026-07-30.xlsx', createdAt: '2026-07-30T08:00:00Z' }]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true, canManagePublications: true })
      if (path.endsWith('/prisma')) return jsonResponse({})
      if (path.endsWith('/artifact-1') && init?.method === 'DELETE') {
        artifacts = []
        return jsonResponse(undefined, 204)
      }
      if (path.endsWith('/exports')) return jsonResponse(artifacts)
      return jsonResponse([])
    })
    renderWithProviders(<ReportingPage />, { route: '/projects/p1/reporting', path: '/projects/:projectId/reporting' })

    const link = await screen.findByRole('link', { name: 'Review_2026-07-30.xlsx' })
    expect(link).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('alertdialog', { name: 'Delete export?' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Export' }))

    await waitForElementToBeRemoved(() => screen.queryByRole('link', { name: 'Review_2026-07-30.xlsx' }))
    const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(String(deleteCall?.[0])).toBe('/api/v1/projects/p1/exports/artifact-1')
  })

  it('shows the PRISMA flow diagram inline, sourced from the project-scoped SVG endpoint', async () => {
    mockFetch(async (input) => String(input).endsWith('/prisma') ? jsonResponse({}) : jsonResponse([]))
    renderWithProviders(<ReportingPage />, { route: '/projects/p1/reporting', path: '/projects/:projectId/reporting' })

    const figure = await screen.findByAltText(/PRISMA flow diagram/)
    expect(figure).toHaveAttribute('src', '/api/v1/projects/p1/prisma/svg')
    expect(screen.getByText('Study selection')).toHaveClass('eyebrow')
    expect(screen.getByRole('heading', { name: 'PRISMA Flow' })).toBeInTheDocument()
    expect(screen.queryByText('Living diagram')).not.toBeInTheDocument()
    expect(screen.queryByText(/Counts update automatically/)).not.toBeInTheDocument()
  })

  it('offers all required export families', async () => {
    mockFetch(async (input) => String(input).endsWith('/prisma') ? jsonResponse({}) : jsonResponse([]))
    renderWithProviders(<ReportingPage />, { route: '/projects/p1/reporting', path: '/projects/:projectId/reporting' })
    await screen.findByRole('heading', { name: 'Reporting and Exports' })

    expect(screen.getByRole('button', { name: 'Generate PRISMA SVG' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate Excel Workbook' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate PRISMA Supporting Tables' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate BibTeX' })).toBeInTheDocument()
  })
})
