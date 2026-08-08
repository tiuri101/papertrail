import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScreeningLlmPanel } from '../LlmTaskComponents'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ScreeningLlmPanel', () => {
  it('does not reveal a title/abstract suggestion before the human decision', async () => {
    mockFetch(async () => jsonResponse({ state: 'hidden', hidden: true }))
    renderWithProviders(
      <ScreeningLlmPanel
        projectId="project-1"
        publicationId="publication-1"
        itemId="item-1"
        stage="title_abstract"
      />,
    )

    expect(await screen.findByText(/Hidden until you submit your own screening decision/)).toBeInTheDocument()
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
    renderWithProviders(
      <ScreeningLlmPanel
        projectId="project-1"
        publicationId="publication-1"
        itemId="item-1"
        stage="title_abstract"
        humanDecision="include"
      />,
    )

    expect(await screen.findByText(/LLM suggestion:/)).toBeInTheDocument()
    expect(screen.getByText(/exclude · medium confidence/)).toBeInTheDocument()
    expect(screen.getByText(/suggestion differ/)).toBeInTheDocument()
    expect(screen.getByText(/Population is in scope/)).toBeInTheDocument()
  })

  it('shows verified page evidence and a stale warning for full-text assistance', async () => {
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
    renderWithProviders(
      <ScreeningLlmPanel
        projectId="project-1"
        publicationId="publication-1"
        itemId="item-1"
        stage="full_text"
      />,
    )

    expect(await screen.findByText(/result is stale/)).toBeInTheDocument()
    expect(screen.getByText(/Verified evidence/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open PDF at page 4' })).toHaveAttribute(
      'href',
      expect.stringContaining('#page=4'),
    )
  })

  it('offers retry without blocking the screen when inference fails', async () => {
    const fetchMock = mockFetch(async (input, init) => (
      init?.method === 'POST'
        ? jsonResponse({ id: 'run-2', status: 'pending' })
        : jsonResponse({ state: 'failed', hidden: false, error: 'Ollama unavailable' })
    ))
    renderWithProviders(
      <ScreeningLlmPanel
        projectId="project-1"
        publicationId="publication-1"
        itemId="item-1"
        stage="full_text"
      />,
    )

    expect(await screen.findByText('Ollama unavailable')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)
    })
  })
})
