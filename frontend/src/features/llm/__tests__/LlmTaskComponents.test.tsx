import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ScreeningLlmPanel, useScreeningLlmAssistance } from '../LlmTaskComponents'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function Harness({
  itemId = 'item-1',
  stage = 'title_abstract',
  humanDecision,
}: {
  itemId?: string
  stage?: 'title_abstract' | 'full_text'
  humanDecision?: string
}) {
  const assistance = useScreeningLlmAssistance({ projectId: 'project-1', itemId, stage, humanDecision })
  return <ScreeningLlmPanel itemId={itemId} stage={stage} humanDecision={humanDecision} assistance={assistance} />
}

describe('ScreeningLlmPanel', () => {
  it('does not reveal a title/abstract suggestion before the human decision', async () => {
    mockFetch(async () => jsonResponse({ state: 'hidden', hidden: true }))
    renderWithProviders(<Harness />)

    expect(await screen.findByText(/Hidden until you submit your own screening decision/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'LLM assistance' })).toHaveTextContent('✦ LLM assistance')
    expect(screen.queryByText(/LLM suggestion:/)).not.toBeInTheDocument()
  })

  it('shows the independent title/abstract result after the human decision', async () => {
    mockFetch(async () => jsonResponse({
      state: 'ready', hidden: false, stale: false, suggestedDecision: 'exclude',
      confidence: 'medium', reasoningSummary: 'The population is outside scope.',
      criteria: [{
        criterionId: 'criterion-1', criterionText: 'Population is in scope',
        criterionKind: 'inclusion', assessment: 'not_met',
        explanation: 'The abstract describes clinicians rather than patients.',
        evidence: [], evidenceValidationStatus: 'not_required',
      }],
    }))
    renderWithProviders(<Harness humanDecision="include" />)

    expect(await screen.findByText(/LLM suggestion:/)).toBeInTheDocument()
    expect(screen.getByText(/exclude · medium confidence/)).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: /differs from your decision/ })).toHaveAttribute('data-comparison', 'mismatch')
    expect(screen.getByText(/breakdown/)).toBeInTheDocument()
  })

  it('marks a matching title/abstract decision and scrolls the revealed result into view', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    mockFetch(async () => jsonResponse({
      state: 'ready', hidden: false, runId: 'run-1', stale: false,
      suggestedDecision: 'include', confidence: 'high',
      reasoningSummary: 'All criteria are fulfilled.', criteria: [],
    }))
    renderWithProviders(<Harness humanDecision="include" />)

    const panel = await screen.findByRole('complementary', { name: /matches your decision/ })
    expect(panel).toHaveAttribute('data-comparison', 'match')
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    })
  })

  it('shows a stale warning for full-text assistance', async () => {
    mockFetch(async () => jsonResponse({
      state: 'ready', hidden: false, stale: true, suggestedDecision: 'include',
      confidence: 'high', reasoningSummary: 'Every criterion is supported.',
      criteria: [{
        criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
        criterionKind: 'inclusion', assessment: 'met', explanation: 'A study is reported.',
        evidenceValidationStatus: 'verified',
        evidence: [{
          page: 4, section: 'Methods', quote: 'We conducted a controlled user study.',
          verified: true,
        }],
      }],
    }))
    renderWithProviders(<Harness stage="full_text" />)

    expect(await screen.findByText(/result is stale/)).toBeInTheDocument()
  })

  it('offers retry without blocking the screen when inference fails', async () => {
    const fetchMock = mockFetch(async (input, init) => (
      init?.method === 'POST'
        ? jsonResponse({ id: 'run-2', status: 'pending' })
        : jsonResponse({ state: 'failed', hidden: false, error: 'Ollama unavailable' })
    ))
    renderWithProviders(<Harness stage="full_text" />)

    expect(await screen.findByText('Ollama unavailable')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
  })
})
