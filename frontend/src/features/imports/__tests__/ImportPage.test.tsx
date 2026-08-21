import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
  const monthLabel = within(dialog).getByText(new RegExp(`^(${MONTHS.join('|')}) \\d{4}$`))
  const [monthName, yearText] = monthLabel.textContent.split(' ')
  const monthsToMove = (targetYear - Number(yearText)) * 12 + (targetMonth - MONTHS.indexOf(monthName))
  const navButtonName = monthsToMove < 0 ? 'Previous month' : 'Next month'
  for (let step = 0; step < Math.abs(monthsToMove); step += 1) {
    fireEvent.click(within(dialog).getByRole('button', { name: navButtonName }))
  }

  const daysGrid = within(dialog).getByRole('grid')
  const dayButtons = within(daysGrid).getAllByRole('button', { name: day })
  const targetButton = dayButtons.find((button) => button.dataset.inMonth === 'true')
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
    expect(screen.getByRole('heading', { name: 'Searches and Imports' })).toBeInTheDocument()
    const importToggle = screen.getByRole('button', { name: 'Import a Database Export' })
    expect(importToggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('#section-import-records')?.nextElementSibling).toHaveAttribute(
      'id',
      'section-search-history',
    )
    expect(screen.getByLabelText('Optional full-text PDFs')).toBeInTheDocument()
    const zipInput = screen.getByLabelText('Optional PDF ZIPs')
    expect(zipInput).toBeInTheDocument()
    expect(zipInput).toHaveAttribute('multiple')
    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument()
    expect(screen.queryByText(/Not documented/)).not.toBeInTheDocument()
  })

  it('expands the import card by default when no searches have been documented', async () => {
    mockFetch(() => jsonResponse([]))
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    const importToggle = await screen.findByRole('button', { name: 'Import a Database Export' })
    expect(importToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('No searches have been documented for this project yet.')).toBeInTheDocument()
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
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
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
      if (url.endsWith('/pdf-matches')) {
        const needsReview = jobStatus === 'completed'
        return jsonResponse({
          summary: {
            total: needsReview ? 2 : 0,
            matched: 0,
            ambiguous: needsReview ? 1 : 0,
            unmatched: needsReview ? 1 : 0,
            conflict_existing_pdf: 0,
            duplicate: 0,
            invalid: 0,
            skipped: 0,
          },
          items: [],
          publications: [],
        })
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
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    })
    scrollIntoView.mockRestore()
  })

  it('lists previously documented searches for reference', async () => {
    mockFetch(() => jsonResponse([
      {
        id: 'search-1',
        sourceName: 'IEEE Xplore',
        query: 'virtual reality AND urban',
        searchDate: '2026-07-30',
        filters: 'Journals and conferences',
        exportedResultCount: 12,
        createdAt: '2026-07-30T08:30:00Z',
        createdBy: { id: 'reviewer-1', displayName: 'Ada Reviewer', username: 'ada' },
        importBatches: [
          {
            id: 'batch-1',
            originalFilename: 'records.csv',
            status: 'completed',
            recordCount: 12,
            attachedPaperCount: 7,
            completedAt: '2026-07-30T09:00:00Z',
          },
        ],
      },
    ]))
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    expect(await screen.findByText('Previously Documented Searches')).toBeInTheDocument()
    const history = screen.getByRole('region', { name: 'Previously Documented Searches' })
    expect(await within(history).findByText('IEEE Xplore')).toBeInTheDocument()
    expect(within(history).getByText('virtual reality AND urban')).toBeInTheDocument()
    expect(within(history).getByText('Journals and conferences')).toBeInTheDocument()
    expect(within(history).getByText('Ada Reviewer (ada)')).toBeInTheDocument()
    expect(within(history).getByLabelText('12 papers')).toBeInTheDocument()
    expect(within(history).getByText('1 import · 12 records · 7 imported papers with PDF')).toBeInTheDocument()
    expect(within(history).getByText('records.csv')).toBeInTheDocument()
    expect(within(history).getByText('Completed')).toBeInTheDocument()
  })

  it('allows bulk-attaching PDFs to a search documented in an earlier session', async () => {
    setCsrfToken('csrf-import')
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/project-1')) return jsonResponse({ id: 'project-1', canManage: true })
      if (url.endsWith('/searches')) {
        return jsonResponse([
          {
            id: 'search-1',
            sourceName: 'IEEE Xplore',
            query: 'virtual reality AND urban',
            searchDate: '2026-07-30',
            filters: null,
            importBatches: [
              {
                id: 'batch-1',
                originalFilename: 'records.csv',
                status: 'completed',
                recordCount: 12,
                attachedPaperCount: 4,
                completedAt: '2026-07-30T09:00:00Z',
              },
            ],
          },
        ])
      }
      if (init?.method === 'POST' && url.endsWith('/imports/batch-1/pdfs')) {
        return jsonResponse({
          importBatchId: 'batch-1',
          summary: { total: 1, matched: 1, ambiguous: 0, unmatched: 0, duplicate: 0, conflict_existing_pdf: 0, invalid: 0, skipped: 0 },
        })
      }
      if (url.includes('/pdf-matches')) {
        return jsonResponse({ importBatchId: 'batch-1', summary: { total: 1, matched: 1, ambiguous: 0, unmatched: 0, duplicate: 0, conflict_existing_pdf: 0, invalid: 0, skipped: 0 }, items: [], publications: [] })
      }
      return jsonResponse({})
    })
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    const importFile = (await screen.findByText('records.csv')).closest('.search-history__import-details') as HTMLElement
    expect(within(importFile).getByText(/12 records · 4 papers with PDF/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Attach PDFs' }))

    const pdf = new File(['pdf-1'], 'paper-1.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('PDF files'), { target: { files: [pdf] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload PDFs' }))

    await waitFor(() => {
      const uploadCall = fetchMock.mock.calls.find(([callInput]) => String(callInput) === '/api/v1/projects/project-1/imports/batch-1/pdfs')
      expect(uploadCall).toBeTruthy()
      const [, init] = uploadCall!
      expect(init?.credentials).toBe('include')
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-import')
      expect((init?.body as FormData).getAll('pdfs')).toEqual([pdf])
    })

    expect(await screen.findByText('1 files processed · 1 matched')).toBeInTheDocument()
    expect(screen.getByText('Review PDF matches')).toBeInTheDocument()
  })

  it('warns about already-screened papers before deleting a search, then deletes on confirmation', async () => {
    let deleted = false
    mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/project-1')) return jsonResponse({ id: 'project-1', canManage: true })
      if (init?.method === 'DELETE' && url.includes('/searches/search-1')) {
        if (url.includes('force=true')) {
          deleted = true
          return jsonResponse({ deleted: true, requiresConfirmation: false, publicationCount: 2, screenedPublicationCount: 1 })
        }
        return jsonResponse({
          deleted: false,
          requiresConfirmation: true,
          publicationCount: 2,
          screenedPublicationCount: 1,
          screenedPublicationTitles: ['Screened Paper'],
        })
      }
      if (url.endsWith('/searches')) {
        return jsonResponse(deleted ? [] : [
          { id: 'search-1', sourceName: 'IEEE Xplore', query: 'virtual reality', searchDate: '2026-07-30', filters: null },
        ])
      }
      return jsonResponse({})
    })
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    expect(await screen.findByText('IEEE Xplore')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Delete search/ }))

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText(/One of these papers has already been screened/)).toBeInTheDocument()
    expect(screen.getByText(/all 2 papers it exclusively brought in/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Search' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(screen.getByText('No searches have been documented for this project yet.')).toBeInTheDocument()
  })

  it('lets the reviewer cancel out of deleting a search without calling the API', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (url.endsWith('/projects/project-1')) return jsonResponse({ id: 'project-1', canManage: true })
      if (init?.method === 'DELETE' && url.includes('/searches/search-1')) {
        return jsonResponse({ deleted: false, requiresConfirmation: true, publicationCount: 0, screenedPublicationCount: 0 })
      }
      if (url.endsWith('/searches')) {
        return jsonResponse([
          { id: 'search-1', sourceName: 'IEEE Xplore', query: 'virtual reality', searchDate: '2026-07-30', filters: null },
        ])
      }
      return jsonResponse({})
    })
    renderWithProviders(<ImportPage />, { route: '/projects/project-1/imports', path: '/projects/:projectId/imports' })

    expect(await screen.findByText('IEEE Xplore')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Delete search/ }))
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([callInput, callInit]) => callInit?.method === 'DELETE' && String(callInput).includes('force=true'))).toBe(false)
  })
})
