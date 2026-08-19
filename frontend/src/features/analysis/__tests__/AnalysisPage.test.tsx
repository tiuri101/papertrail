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
  narrativeEnabled: true,
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
  narrativeEnabled: true,
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
  narrativeEnabled: true,
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
  narrativeEnabled: true,
}

const reviewerAnalysisResponse = {
  stage: 'title_abstract',
  overall: {
    comparingReviewerCount: 2,
    publicationsWithCompleteSet: 3,
    totalOriginalDecisions: 6,
    rawAgreementRate: 0.67,
    publicationDisagreementRate: 0.33,
    uncertainDecisionRate: 0,
    nonAgreementResolutionCount: 1,
    nonAgreementResolutionRate: 0.33,
    revisionRate: 0,
  },
  pairwise: [
    {
      reviewerA: 'Reviewer A',
      reviewerB: 'Reviewer B',
      publicationsCompared: 3,
      agreeing: 2,
      rawAgreementRate: 0.67,
      cohensKappa: null,
      confusionMatrix: {
        categories: ['include', 'exclude'],
        rows: [
          { actual: 'include', counts: { include: 2, exclude: 0 } },
          { actual: 'exclude', counts: { include: 1, exclude: 0 } },
        ],
      },
    },
  ],
  multiReviewer: { kappa: null, unavailableReason: 'No publication has more than two original reviewers' },
  criteria: [],
  disagreementTrend: [],
  reviewerSummary: [
    {
      reviewer: 'Reviewer A',
      originalDecisions: 3,
      revisedDecisions: 0,
      revisionRate: 0,
      titleAbstractCount: 3,
      fullTextCount: 0,
    },
    {
      reviewer: 'Reviewer B',
      originalDecisions: 3,
      revisedDecisions: 0,
      revisionRate: 0,
      titleAbstractCount: 3,
      fullTextCount: 0,
    },
  ],
}

const evidenceMatrixResponse = {
  columns: [],
  items: [],
  total: 0,
  page: 1,
  pageSize: 25,
  qualityEnabled: false,
}

function baseFetchHandler(input: RequestInfo | URL) {
  const path = String(input)
  if (path.endsWith('/analysis/duplicate_review')) return jsonResponse(duplicateReviewResponse)
  if (path.endsWith('/analysis/title_abstract_screening')) return jsonResponse(titleAbstractResponse)
  if (path.endsWith('/analysis/full_text_screening')) return jsonResponse(fullTextResponse)
  if (path.endsWith('/analysis/extraction_quality')) return jsonResponse(extractionResponse)
  if (path.endsWith('/analysis/reviewer-analysis/title_abstract')) return jsonResponse(reviewerAnalysisResponse)
  if (path.endsWith('/analysis/reviewer-analysis/full_text')) {
    return jsonResponse({ ...reviewerAnalysisResponse, stage: 'full_text', pairwise: [], reviewerSummary: [] })
  }
  if (path.endsWith('/evidence-matrix')) return jsonResponse(evidenceMatrixResponse)
  if (/\/api\/v1\/projects\/[^/]+$/.test(path)) return jsonResponse({ researchQuestions: [] })
  if (path.endsWith('/jobs')) return jsonResponse([])
  return jsonResponse({})
}

describe('AnalysisPage', () => {
  it('groups sections into tabs, each showing its own headings in order', async () => {
    mockFetch(baseFetchHandler)

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    // Deduplication tab is active by default.
    expect(await screen.findByRole('heading', { name: 'Deduplication' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Title/Abstract Screening' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /Screening/ }))
    expect(await screen.findByRole('heading', { name: 'Title/Abstract Screening' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Full-Text Screening' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Reviewer Analysis' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Deduplication' })).not.toBeInTheDocument()
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((el) => el.textContent),
    ).toEqual(['Title/Abstract Screening', 'Full-Text Screening', 'Reviewer Analysis'])

    fireEvent.click(screen.getByRole('tab', { name: 'Extraction & Quality' }))
    expect(await screen.findByRole('heading', { name: 'Extraction & Quality' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Evidence Matrix' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Reviewer Analysis' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Research Questions' }))
    expect(await screen.findByRole('heading', { name: 'Research Question Analysis' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Evidence Matrix' })).not.toBeInTheDocument()
  })

  it('shows anonymized reviewer agreement with N/A (never 0) for undefined kappa, and expands a confusion matrix', async () => {
    mockFetch(baseFetchHandler)

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    fireEvent.click(await screen.findByRole('tab', { name: /Screening/ }))
    const reviewerSection = (
      await screen.findByRole('heading', { name: 'Reviewer Analysis' })
    ).closest('section') as HTMLElement
    const withinReviewer = within(reviewerSection)

    const pairwiseRow = (await withinReviewer.findByText('Reviewer A vs Reviewer B')).closest('tr') as HTMLElement
    const withinPairwiseRow = within(pairwiseRow)
    expect(withinPairwiseRow.getAllByText('N/A').length).toBeGreaterThan(0)
    expect(withinPairwiseRow.queryByText(/^0(\.00)?$/)).not.toBeInTheDocument()

    fireEvent.click(withinReviewer.getByRole('button', { name: 'Show confusion matrix' }))
    expect(withinReviewer.getByText('Reviewer A (rows) vs Reviewer B (columns)')).toBeInTheDocument()

    expect(withinReviewer.getByText('Reviewer A')).toBeInTheDocument()
    expect(withinReviewer.getByText('Reviewer B')).toBeInTheDocument()
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

    fireEvent.click(await screen.findByRole('tab', { name: /Screening/ }))
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

    fireEvent.click(await screen.findByRole('tab', { name: /Screening/ }))
    const fullTextSection = (
      await screen.findByRole('heading', { name: 'Full-Text Screening' })
    ).closest('section') as HTMLElement
    expect(fullTextSection).not.toBeNull()
    const withinFullText = within(fullTextSection)

    fireEvent.click(await withinFullText.findByRole('button', { name: 'Generate summary' }))

    await waitFor(() => expect(regenerated).toBe(true))
  })

  it('hides the interpretation panel entirely when narratives are disabled for the project', async () => {
    mockFetch((input) => {
      const path = String(input)
      if (path.endsWith('/analysis/full_text_screening')) {
        return jsonResponse({ ...fullTextResponse, narrativeEnabled: false })
      }
      return baseFetchHandler(input)
    })

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    fireEvent.click(await screen.findByRole('tab', { name: /Screening/ }))
    const fullTextSection = (
      await screen.findByRole('heading', { name: 'Full-Text Screening' })
    ).closest('section') as HTMLElement
    const withinFullText = within(fullTextSection)
    await waitFor(() => expect(withinFullText.getByRole('heading', { name: 'Outcomes' })).toBeInTheDocument())

    expect(withinFullText.queryByRole('heading', { name: 'Interpretation' })).not.toBeInTheDocument()
    expect(withinFullText.queryByText('No summary generated yet.')).not.toBeInTheDocument()
    expect(withinFullText.queryByRole('button', { name: 'Generate summary' })).not.toBeInTheDocument()
  })

  it('shows extraction and quality field breakdowns', async () => {
    mockFetch(baseFetchHandler)

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    fireEvent.click(await screen.findByRole('tab', { name: 'Extraction & Quality' }))
    expect(await screen.findByText('3 included publications.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Study design' })).toBeInTheDocument()
    expect(screen.getByText('2 of 3 answered (67%)')).toBeInTheDocument()
  })
})
