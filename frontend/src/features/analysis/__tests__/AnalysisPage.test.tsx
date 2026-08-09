import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { AnalysisPage } from '../AnalysisPage'

const duplicateReviewResponse = {
  stats: {
    recordsIdentified: 12,
    duplicatesRemoved: 3,
    uniqueRecordsRemaining: 9,
    matchReasonCounts: [{ label: 'title_match', count: 2 }],
  },
  narrative: null,
  isStale: true,
}

const titleAbstractResponse = {
  stats: {
    recordsScreened: 9,
    recordsExcluded: 4,
    outcomeCounts: [
      { label: 'Included', count: 5 },
      { label: 'Excluded', count: 4 },
    ],
    exclusionReasonCounts: [{ label: 'Wrong population', count: 3 }],
  },
  narrative: { summary: 'Screening summary text.', generatedAt: '2026-08-10T00:00:00Z' },
  isStale: false,
}

const fullTextResponse = {
  stats: {
    reportsSought: 5,
    reportsNotRetrieved: 1,
    reportsAssessed: 4,
    includedPublications: 3,
    retrievalStatusCounts: [{ label: 'Not found', count: 1 }],
    outcomeCounts: [
      { label: 'Included', count: 3 },
      { label: 'Excluded', count: 1 },
    ],
    exclusionReasonCounts: [{ label: 'Wrong outcome', count: 1 }],
  },
  narrative: null,
  isStale: true,
}

const extractionResponse = {
  stats: {
    totalPublications: 3,
    qualityTotalScore: null,
    fields: [
      {
        id: 'field-1',
        stableKey: 'design',
        label: 'Study design',
        fieldType: 'single_select',
        source: 'extraction',
        answeredCount: 2,
        totalCount: 3,
        optionCounts: [{ option: 'RCT', count: 2 }],
      },
    ],
  },
  narrative: null,
  isStale: true,
}

function baseFetchHandler(input: RequestInfo | URL) {
  const path = String(input)
  if (path.endsWith('/analysis/duplicate_review')) return jsonResponse(duplicateReviewResponse)
  if (path.endsWith('/analysis/title_abstract_screening')) return jsonResponse(titleAbstractResponse)
  if (path.endsWith('/analysis/full_text_screening')) return jsonResponse(fullTextResponse)
  if (path.endsWith('/analysis/extraction_quality')) return jsonResponse(extractionResponse)
  if (path.endsWith('/jobs')) return jsonResponse([])
  return jsonResponse({})
}

describe('AnalysisPage', () => {
  it('renders a heading for each pipeline stage', async () => {
    mockFetch(baseFetchHandler)

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    expect(await screen.findByRole('heading', { name: 'Deduplication' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Title/Abstract Screening' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Full-Text Screening' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Extraction & Quality' })).toBeInTheDocument()
  })

  it('shows deduplication counts and why records were merged', async () => {
    mockFetch(baseFetchHandler)

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    expect(
      await screen.findByText('12 records identified · 3 removed as duplicates'),
    ).toBeInTheDocument()
    expect(screen.getByText('9 of 12 unique records remaining (75%)')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Why records were merged' })).toBeInTheDocument()
  })

  it('shows a fresh narrative without a stale banner when the fingerprint matches', async () => {
    mockFetch(baseFetchHandler)

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    expect(await screen.findByText('Screening summary text.')).toBeInTheDocument()
    expect(screen.queryByText(/may be outdated/)).not.toBeInTheDocument()
  })

  it('shows a stale banner and regenerates a narrative on demand', async () => {
    let regenerated = false
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/analysis/full_text_screening/regenerate') && init?.method === 'POST') {
        regenerated = true
        return jsonResponse({ jobId: 'job-1' })
      }
      if (path.endsWith('/jobs')) {
        return jsonResponse([
          {
            id: 'job-1',
            jobType: 'generate_stage_analysis',
            status: 'completed',
            progressCurrent: 0,
            progressTotal: 0,
            progressMessage: null,
            errorMessage: null,
            createdAt: '2026-08-10T00:00:00Z',
            completedAt: '2026-08-10T00:00:05Z',
          },
        ])
      }
      return baseFetchHandler(input)
    })

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    const fullTextSection = (
      await screen.findByRole('heading', { name: 'Full-Text Screening' })
    ).closest('section') as HTMLElement
    expect(fullTextSection).not.toBeNull()
    const withinFullText = within(fullTextSection)

    fireEvent.click(await withinFullText.findByRole('button', { name: 'Generate summary' }))

    await waitFor(() => expect(regenerated).toBe(true))
  })

  it('shows extraction and quality field breakdowns', async () => {
    mockFetch(baseFetchHandler)

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    expect(await screen.findByText('3 included publications.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Study design' })).toBeInTheDocument()
    expect(screen.getByText('2 of 3 answered (67%)')).toBeInTheDocument()
  })
})
