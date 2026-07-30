import { fireEvent, screen, waitFor } from '@testing-library/react'
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

  it('offers all required export families', async () => {
    mockFetch(async (input) => String(input).endsWith('/prisma') ? jsonResponse({}) : jsonResponse([]))
    renderWithProviders(<ReportingPage />, { route: '/projects/p1/reporting', path: '/projects/:projectId/reporting' })
    await screen.findByRole('heading', { name: 'Reporting and exports' })

    expect(screen.getByRole('button', { name: 'Generate PRISMA SVG' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate Excel workbook' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate BibTeX' })).toBeInTheDocument()
  })
})
