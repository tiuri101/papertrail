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
    matchReasonCounts: [
      { label: 'exact_doi', count: 2 },
      { label: 'similar_title_authors', count: 1 },
    ],
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
    completedExtractions: 2,
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
  configuredReviewerCount: 2,
  eligibleReviewerCount: 2,
  overall: {
    comparingReviewerCount: 2,
    maximumReviewerCount: 2,
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
  if (/\/api\/v1\/projects\/[^/]+$/.test(path)) {
    return jsonResponse({ stage: 'completed', researchQuestions: [] })
  }
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

    expect((await screen.findAllByRole('tab')).map((tab) => tab.textContent)).toEqual([
      'General',
      'Deduplication',
      'Screening',
      'Extraction & Quality',
      'Research Questions',
    ])
    const generalOverviewHeading = await screen.findByRole('heading', { name: 'General Overview' })
    expect(generalOverviewHeading).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Review Funnel' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Stage Details' })).toBeInTheDocument()
    expect(screen.getAllByText('Records imported')[0].closest('div')).toHaveTextContent('12')
    expect(screen.getAllByText('Extractions completed')[0].closest('div')).toHaveTextContent('2')
    expect(screen.getByText('Pending extractions').closest('div')).toHaveTextContent('1')

    fireEvent.click(screen.getByRole('tab', { name: 'Deduplication' }))
    expect(await screen.findByRole('heading', { name: 'Deduplication' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'General Overview' })).not.toBeInTheDocument()

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

    const confusionTable = withinReviewer.getByText('Reviewer A (rows) vs Reviewer B (columns)').closest('table') as HTMLElement
    expect(within(confusionTable).getAllByText('Include').length).toBeGreaterThan(0)
    expect(within(confusionTable).getAllByText('Exclude').length).toBeGreaterThan(0)
    expect(within(confusionTable).queryByText('include')).not.toBeInTheDocument()
    expect(within(confusionTable).queryByText('exclude')).not.toBeInTheDocument()
    expect(withinReviewer.queryByRole('heading', { name: 'Multi-reviewer agreement' })).not.toBeInTheDocument()
    expect(withinReviewer.queryByRole('heading', { name: 'Criterion-level agreement' })).not.toBeInTheDocument()
    expect(withinReviewer.queryByRole('heading', { name: 'Disagreement over time' })).not.toBeInTheDocument()
  })

  it('shows only analysis from stages that have already completed', async () => {
    const requests: string[] = []
    mockFetch((input) => {
      const path = String(input)
      requests.push(path)
      if (/\/api\/v1\/projects\/[^/]+$/.test(path)) {
        return jsonResponse({ stage: 'full_text_screening', researchQuestions: [] })
      }
      return baseFetchHandler(input)
    })

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    expect(await screen.findAllByText('Included (Title/Abstract)')).toHaveLength(2)
    expect(screen.queryByText('Included (Full-Text)')).not.toBeInTheDocument()
    expect(screen.queryByText('Extractions completed')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Deduplication' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: 'Screening' })).toBeEnabled()
    expect(screen.getByRole('tab', { name: 'Extraction & Quality' })).toBeDisabled()
    expect(screen.getByRole('tab', { name: 'Research Questions' })).toBeDisabled()
    expect(requests.some((path) => path.endsWith('/analysis/full_text_screening'))).toBe(false)
    expect(requests.some((path) => path.endsWith('/analysis/extraction_quality'))).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: 'Screening' }))
    expect(await screen.findByRole('heading', { name: 'Title/Abstract Screening' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Full-Text Screening' })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(requests.some((path) => path.endsWith('/reviewer-analysis/title_abstract'))).toBe(true)
    })
    expect(requests.some((path) => path.endsWith('/reviewer-analysis/full_text'))).toBe(false)
  })

  it('hides reviewer analysis for stages configured for or limited to one reviewer', async () => {
    mockFetch((input) => {
      const path = String(input)
      if (path.includes('/analysis/reviewer-analysis/')) {
        return jsonResponse({
          ...reviewerAnalysisResponse,
          stage: path.endsWith('/full_text') ? 'full_text' : 'title_abstract',
          configuredReviewerCount: path.endsWith('/full_text') ? 2 : 1,
          eligibleReviewerCount: path.endsWith('/full_text') ? 1 : 2,
          reviewerSummary: reviewerAnalysisResponse.reviewerSummary.slice(0, 1),
        })
      }
      return baseFetchHandler(input)
    })

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    fireEvent.click(await screen.findByRole('tab', { name: /Screening/ }))
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Reviewer Analysis' })).not.toBeInTheDocument()
    })
  })

  it('shows one useful message instead of empty agreement sections before reviews overlap', async () => {
    mockFetch((input) => {
      const path = String(input)
      if (path.endsWith('/analysis/reviewer-analysis/title_abstract')) {
        return jsonResponse({
          ...reviewerAnalysisResponse,
          overall: {
            ...reviewerAnalysisResponse.overall,
            comparingReviewerCount: 0,
            maximumReviewerCount: 0,
            publicationsWithCompleteSet: 0,
            totalOriginalDecisions: 0,
            rawAgreementRate: null,
            publicationDisagreementRate: null,
          },
          pairwise: [],
          criteria: [],
          disagreementTrend: [],
          reviewerSummary: [],
        })
      }
      if (path.endsWith('/analysis/reviewer-analysis/full_text')) {
        return jsonResponse({
          ...reviewerAnalysisResponse,
          stage: 'full_text',
          configuredReviewerCount: 1,
          reviewerSummary: [],
        })
      }
      return baseFetchHandler(input)
    })

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    fireEvent.click(await screen.findByRole('tab', { name: /Screening/ }))
    const reviewerSection = (
      await screen.findByRole('heading', { name: 'Reviewer Analysis' })
    ).closest('section') as HTMLElement
    expect(await within(reviewerSection).findByText(/after at least two reviewers/)).toBeInTheDocument()
    expect(within(reviewerSection).queryByText('Raw agreement')).not.toBeInTheDocument()
    expect(within(reviewerSection).queryByText('Pairwise reviewer agreement')).not.toBeInTheDocument()
  })

  it('shows deduplication counts and why records were merged', async () => {
    mockFetch(baseFetchHandler)

    renderWithProviders(<AnalysisPage />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    fireEvent.click(await screen.findByRole('tab', { name: 'Deduplication' }))
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
