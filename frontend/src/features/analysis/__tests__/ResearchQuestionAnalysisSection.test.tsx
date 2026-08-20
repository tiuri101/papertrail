import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { ResearchQuestionAnalysisSection } from '../ResearchQuestionAnalysisSection'
import type { RqAnalysisResponse } from '../useResearchQuestionAnalysis'

const projectResponse = {
  researchQuestions: [{ id: 'rq-1', text: 'What study designs were used?' }],
}

function analysisResponse(overrides: Partial<RqAnalysisResponse> = {}): RqAnalysisResponse {
  return {
    researchQuestionId: 'rq-1',
    researchQuestionText: 'What study designs were used?',
    synthesisEnabled: true,
    isStale: false,
    latestRun: {
      id: 'run-1',
      status: 'completed',
      generatedAt: '2026-08-01T00:00:00Z',
      statements: [
        { claim: 'Most included studies used a randomized design.', sourceIds: ['SRC-0001'] },
      ],
      limitations: ['Only one publication contributed data.'],
      sourceRefs: {
        'SRC-0001': {
          publicationId: 'pub-1',
          publicationTitle: 'Alpha Study',
          sourceType: 'extraction',
          fieldKey: 'design',
          label: 'Study Design',
          value: 'RCT',
          evidence: [{ page: 3, quote: 'A randomized trial.', section: 'Methods', verified: true }],
        },
      },
      model: 'test-model',
      promptVersion: 'rq_synthesis_v1',
      error: null,
    },
    ...overrides,
  }
}

function baseHandler(analysis: RqAnalysisResponse) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    if (/\/api\/v1\/projects\/p1$/.test(path)) return jsonResponse(projectResponse)
    if (path.endsWith('/research-questions/rq-1/analysis') && method === 'GET') {
      return jsonResponse(analysis)
    }
    if (path.endsWith('/research-questions/rq-1/analysis/regenerate')) {
      return jsonResponse({ jobId: 'job-1' })
    }
    if (path.endsWith('/jobs')) {
      return jsonResponse([{ id: 'job-1', jobType: 'generate_rq_synthesis', status: 'completed', progressCurrent: 0, progressTotal: 0, progressMessage: null, errorMessage: null, createdAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-01T00:00:01Z' }])
    }
    return jsonResponse({})
  }
}

describe('ResearchQuestionAnalysisSection', () => {
  it('renders the synthesis without preloading evidence cards on the right', async () => {
    mockFetch(baseHandler(analysisResponse()))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    expect(await screen.findByText('What study designs were used?')).toBeInTheDocument()
    expect(screen.getByText('RQ1')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Synthesis for RQ1' })).toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByText('Alpha Study')).not.toBeInTheDocument()
    expect(screen.getByText('Most included studies used a randomized design.')).toBeInTheDocument()
    expect(screen.getByText('Only one publication contributed data.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument()
  })

  it('expands a source badge to show the traceable evidence quote', async () => {
    mockFetch(baseHandler(analysisResponse()))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    await screen.findByText('Most included studies used a randomized design.')
    expect(screen.queryByText(/A randomized trial\./)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'SRC-0001' }))

    expect(screen.getByText(/Alpha Study/)).toBeInTheDocument()
    expect(screen.getByText(/A randomized trial\./)).toBeInTheDocument()
  })

  it('shows only the evidence item selected from the synthesis', async () => {
    const withManySources = analysisResponse()
    const sourceTemplate = withManySources.latestRun!.sourceRefs['SRC-0001']
    withManySources.latestRun!.sourceRefs = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => {
        const number = index + 1
        const sourceId = `SRC-000${number}`
        return [sourceId, {
          ...sourceTemplate,
          publicationId: `pub-${number}`,
          publicationTitle: `Study ${number}`,
          value: `Value ${number}`,
          evidence: [{
            page: number,
            quote: `Evidence quote ${number}`,
            section: 'Results',
            verified: true,
          }],
        }]
      }),
    )
    withManySources.latestRun!.statements = [{
      claim: 'A finding supported by a source outside the initial evidence limit.',
      sourceIds: ['SRC-0005', 'SRC-0002'],
    }]
    mockFetch(baseHandler(withManySources))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    await screen.findByText('A finding supported by a source outside the initial evidence limit.')
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'SRC-0005' }))

    const panel = screen.getByRole('complementary', { name: 'Selected evidence SRC-0005' })
    expect(within(panel).getByText('Evidence quote 5')).toBeInTheDocument()
    expect(within(panel).queryByText('Study 1')).not.toBeInTheDocument()
    expect(within(panel).queryByText('Study 2')).not.toBeInTheDocument()
    const visibleCards = panel.querySelectorAll('.rq-evidence-card')
    expect(visibleCards).toHaveLength(1)
    expect(visibleCards[0]).toHaveAttribute('id', 'rq-1-evidence-SRC-0005')

    fireEvent.click(screen.getByRole('button', { name: 'SRC-0002' }))
    const replacement = screen.getByRole('complementary', { name: 'Selected evidence SRC-0002' })
    expect(within(replacement).getByText('Evidence quote 2')).toBeInTheDocument()
    expect(screen.queryByText('Evidence quote 5')).not.toBeInTheDocument()
  })

  it('distinguishes a source id whose value has no traceable quotation', async () => {
    const withoutQuotation = analysisResponse()
    withoutQuotation.latestRun!.sourceRefs['SRC-0001'].evidence = []
    mockFetch(baseHandler(withoutQuotation))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    const source = await screen.findByRole('button', { name: 'SRC-0001' })
    expect(source).toHaveClass('rq-source-badge--untraceable')
    expect(source).toHaveAttribute('title', 'No traceable source quotation for this value')

    fireEvent.click(source)
    const panel = screen.getByRole('complementary', { name: 'Selected evidence SRC-0001' })
    expect(within(panel).getByText('No traceable source quotation for this value.')).toBeInTheDocument()
  })

  it('shows a stale banner when the underlying data changed since generation', async () => {
    mockFetch(baseHandler(analysisResponse({ isStale: true })))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    expect(await screen.findByRole('status')).toHaveTextContent(/may be outdated/)
  })

  it('hides the stale banner when synthesis is disabled, even if the server reports stale', async () => {
    mockFetch(baseHandler(analysisResponse({ synthesisEnabled: false, isStale: true })))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    expect(
      await screen.findByText('AI-generated interpretive analysis is disabled for this project.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Most included studies used a randomized design.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a message and disabled controls when no synthesis has been generated yet', async () => {
    mockFetch(baseHandler(analysisResponse({ latestRun: null })))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    expect(await screen.findByText('No synthesis generated yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate synthesis' })).toBeInTheDocument()
  })

  it('disables generation and explains why when the project has synthesis disabled', async () => {
    mockFetch(baseHandler(analysisResponse({ synthesisEnabled: false, latestRun: null })))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    expect(
      await screen.findByText('AI-generated interpretive analysis is disabled for this project.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate synthesis' })).toBeDisabled()
  })

  it('regenerates and polls the job to completion', async () => {
    mockFetch(baseHandler(analysisResponse()))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    await screen.findByText('Most included studies used a randomized design.')
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeInTheDocument()
    })
  })

  it('shows an empty state when the project has no research questions', async () => {
    mockFetch(() => jsonResponse({ researchQuestions: [] }))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    expect(
      await screen.findByText('No research questions have been defined for this project.'),
    ).toBeInTheDocument()
  })

  it('shows an unknown-source badge state when a cited source id has no ref data', async () => {
    const withMissingRef = analysisResponse()
    withMissingRef.latestRun!.statements = [
      { claim: 'A claim citing a source without ref data.', sourceIds: ['SRC-9999'] },
    ]
    mockFetch(baseHandler(withMissingRef))
    renderWithProviders(<ResearchQuestionAnalysisSection projectId="p1" />)

    const badge = await screen.findByText('SRC-9999')
    expect(badge.tagName).toBe('SPAN')
    expect(within(badge.parentElement as HTMLElement).queryByRole('button')).not.toBeInTheDocument()
  })
})
