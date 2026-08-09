import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ImportPage } from '../ImportPage'
import { setCsrfToken } from '../../auth/session'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function selectDate(labelText: string, iso: string) {
  const [yearStr, monthStr, dayStr] = iso.split('-')
  const targetYear = Number(yearStr)
  const targetMonth = Number(monthStr) - 1
  const day = String(Number(dayStr))

  fireEvent.click(screen.getByLabelText(labelText))
  const dialog = screen.getByRole('dialog', { name: `${labelText} calendar` })
  const monthLabel = dialog.querySelector('.date-field__month')
  const [monthName, yearText] = (monthLabel?.textContent ?? '').split(' ')
  const monthsToMove = (targetYear - Number(yearText)) * 12 + (targetMonth - MONTHS.indexOf(monthName))
  const navButtonName = monthsToMove < 0 ? 'Previous month' : 'Next month'
  for (let step = 0; step < Math.abs(monthsToMove); step += 1) {
    fireEvent.click(within(dialog).getByRole('button', { name: navButtonName }))
  }

  const daysGrid = dialog.querySelector('.date-field__days') as HTMLElement
  const dayButtons = within(daysGrid).getAllByRole('button', { name: day })
  const targetButton = dayButtons.find((button) => !button.className.includes('date-field__day--outside'))
  fireEvent.click(targetButton ?? dayButtons[0])
}

function fillSearchFields() {
  fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'IEEE Xplore' } })
  fireEvent.change(screen.getByLabelText('Search string'), { target: { value: 'virtual reality AND urban' } })
  selectDate('Search date', '2026-07-30')
}

describe('ImportPage', () => {
  it('does not offer a way to skip or reuse a documented search', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/projects/project-1')) return jsonResponse({ id: 'project-1', canManage: true })
      return jsonResponse([
        { id: 'search-1', sourceName: 'IEEE Xplore', query: 'virtual reality AND urban', searchDate: '2026-07-30', filters: null },
      ])
    })
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    await screen.findByLabelText('Bibliographic export')
    expect(screen.getByLabelText('Optional full-text PDFs')).toBeInTheDocument()
    const zipInput = screen.getByLabelText('Optional PDF ZIPs')
    expect(zipInput).toBeInTheDocument()
    expect(zipInput).toHaveAttribute('multiple')
    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument()
    expect(screen.queryByText(/Not documented/)).not.toBeInTheDocument()
  })

  it('documents the search and uploads the file in a single step, with credentials and CSRF protection', async () => {
    setCsrfToken('csrf-import')
    const searches: Array<{ id: string; sourceName: string; query: string; searchDate: string; filters: string | null }> = []
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/project-1')) return jsonResponse({ id: 'project-1', canManage: true })
      if (init?.method === 'POST' && url.endsWith('/searches')) {
        const body = JSON.parse(String(init.body))
        const search = { id: 'search-1', ...body }
        searches.push(search)
        return jsonResponse(search, 201)
      }
      if (url.endsWith('/searches')) return jsonResponse(searches)
      return jsonResponse({ jobId: 'job-42' }, 202)
    })
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    await screen.findByLabelText('Database')
    fillSearchFields()
    const file = new File(['Title,Authors\nPaper,Author'], 'records.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Bibliographic export'), { target: { files: [file] } })
    const pdfs = [
      new File(['pdf-1'], 'paper-1.pdf', { type: 'application/pdf' }),
      new File(['pdf-2'], 'paper-2.pdf', { type: 'application/pdf' }),
    ]
    const archives = [
      new File(['zip-1'], 'papers-1.zip', { type: 'application/zip' }),
      new File(['zip-2'], 'papers-2.zip', { type: 'application/zip' }),
    ]
    fireEvent.change(screen.getByLabelText('Optional full-text PDFs'), {
      target: { files: pdfs },
    })
    fireEvent.change(screen.getByLabelText('Optional PDF ZIPs'), {
      target: { files: archives },
    })
    expect(screen.getByText('paper-1.pdf')).toBeInTheDocument()
    expect(screen.getByText('paper-2.pdf')).toBeInTheDocument()
    expect(screen.getByText('papers-1.zip')).toBeInTheDocument()
    expect(screen.getByText('papers-2.zip')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find(([input, callInit]) => String(input).endsWith('/searches') && callInit?.method === 'POST')
      expect(searchCall).toBeTruthy()
      expect(JSON.parse(String(searchCall?.[1]?.body))).toEqual({
        sourceName: 'IEEE Xplore',
        query: 'virtual reality AND urban',
        searchDate: '2026-07-30',
        filters: null,
      })
    })

    await waitFor(() => {
      const uploadCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/v1/projects/project-1/imports')
      expect(uploadCall).toBeTruthy()
      const [, init] = uploadCall!
      expect(init?.credentials).toBe('include')
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-import')
      expect(init?.body).toBeInstanceOf(FormData)
      expect((init?.body as FormData).get('searchSourceId')).toBe('search-1')
      expect((init?.body as FormData).getAll('pdfs')).toEqual(pdfs)
      expect((init?.body as FormData).getAll('pdfArchive')).toEqual(archives)
    })

    expect(await screen.findByText('Import queued: job-42')).toBeInTheDocument()
  })

  it('shows the server-provided import error', async () => {
    mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/project-1')) return jsonResponse({ id: 'project-1', canManage: true })
      if (init?.method === 'POST' && url.endsWith('/searches')) {
        return jsonResponse({ id: 'search-1', sourceName: 'IEEE Xplore', query: 'urban', searchDate: '2026-07-30', filters: null }, 201)
      }
      if (url.endsWith('/searches')) return jsonResponse([])
      return jsonResponse({ error: { message: 'Unsupported file format' } }, 415)
    })
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    await screen.findByLabelText('Database')
    fillSearchFields()
    fireEvent.change(screen.getByLabelText('Bibliographic export'), {
      target: { files: [new File(['bad'], 'records.txt', { type: 'text/plain' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unsupported file format'))
  })

  it('updates from "queued" to "complete" once the import job finishes', async () => {
    setCsrfToken('csrf-import')
    let jobStatus = 'queued'
    mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/project-1')) return jsonResponse({ id: 'project-1', canManage: true })
      if (init?.method === 'POST' && url.endsWith('/searches')) {
        return jsonResponse({ id: 'search-1', sourceName: 'IEEE Xplore', query: 'urban', searchDate: '2026-07-30', filters: null }, 201)
      }
      if (url.endsWith('/searches')) return jsonResponse([])
      if (init?.method === 'POST' && url.endsWith('/imports')) {
        return jsonResponse({ jobId: 'job-77', importBatchId: 'batch-77' }, 202)
      }
      if (url.endsWith('/jobs')) {
        return jsonResponse([
          {
            id: 'job-77',
            jobType: 'parse_import',
            status: jobStatus,
            progressCurrent: 0,
            progressTotal: 0,
            progressMessage: null,
            errorMessage: null,
            createdAt: '2026-07-30T09:00:00Z',
            completedAt: null,
            result: jobStatus === 'completed' ? {
              pdfs: {
                total: 5,
                matched: 2,
                ambiguous: 1,
                unmatched: 1,
                conflict_existing_pdf: 0,
                duplicate: 1,
                invalid: 0,
                skipped: 0,
              },
            } : null,
          },
        ])
      }
      return jsonResponse([])
    })
    const { queryClient } = renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    await screen.findByLabelText('Database')
    fillSearchFields()
    const file = new File(['Title,Authors\nPaper,Author'], 'records.csv', { type: 'text/csv' })
    fireEvent.change(screen.getByLabelText('Bibliographic export'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    expect(await screen.findByText('Import queued: job-77')).toBeInTheDocument()

    jobStatus = 'completed'
    await queryClient.invalidateQueries({ queryKey: ['jobs', 'project-1'] })

    expect(await screen.findByText('Import complete.')).toBeInTheDocument()
    expect(screen.getByText(/5 files processed · 2 matched · 2 need review/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review PDF matches' })).toBeInTheDocument()
  })

  it('lists previously documented searches for reference', async () => {
    mockFetch(() => jsonResponse([
      { id: 'search-1', sourceName: 'IEEE Xplore', query: 'virtual reality AND urban', searchDate: '2026-07-30', filters: null },
    ]))
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    expect(await screen.findByText('Previously Documented Searches')).toBeInTheDocument()
    expect(screen.getByText(/IEEE Xplore/)).toBeInTheDocument()
  })
})
