import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
    renderWithProviders(
      <ScreeningLlmPanel
        projectId="project-1"
        publicationId="publication-1"
        itemId="item-1"
        stage="title_abstract"
        humanDecision="include"
        criteria={[{ id: 'criterion-1', kind: 'inclusion', text: 'Population is in scope' }]}
      />,
    )

    expect(await screen.findByText(/LLM suggestion:/)).toBeInTheDocument()
    expect(screen.getByText(/exclude · medium confidence/)).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: /differs from your decision/ })).toHaveClass(
      'llm-task-panel--mismatch',
    )
    expect(screen.queryByText(/suggestion differ/)).not.toBeInTheDocument()
    expect(screen.getByText(/Population is in scope/)).toBeInTheDocument()
    expect(screen.getByText('IC1')).toHaveClass('criterion-badge--inclusion')
  })

  it('marks a matching title/abstract decision and scrolls the revealed result into view', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    mockFetch(async () => jsonResponse({
      state: 'ready', hidden: false, runId: 'run-1', stale: false,
      suggestedDecision: 'include', confidence: 'high',
      reasoningSummary: 'All criteria are fulfilled.', criteria: [],
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

    const panel = await screen.findByRole('complementary', { name: /matches your decision/ })
    expect(panel).toHaveClass('llm-task-panel--match')
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    })
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
        criteria={[{ id: 'criterion-1', kind: 'inclusion', text: 'Reports an evaluation' }]}
      />,
    )

    expect(await screen.findByText(/result is stale/)).toBeInTheDocument()
    expect(screen.getByText('IC1')).toHaveClass('criterion-badge--inclusion')
    expect(screen.getByText(/Verified evidence/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open PDF at page 4' })).toHaveAttribute(
      'href',
      expect.stringContaining('#page=4'),
    )
  })

  it('color-codes each criterion where the reviewer answer differs from the LLM assessment', async () => {
    mockFetch(async () => jsonResponse({
      state: 'ready', hidden: false, stale: false, suggestedDecision: 'include',
      confidence: 'medium', reasoningSummary: 'Mixed criteria results.',
      criteria: [
        {
          criterionId: 'criterion-met-match', criterionText: 'Reviewer agrees it is met',
          criterionKind: 'inclusion', assessment: 'met',
          explanation: 'Explanation A', evidence: [], evidenceValidationStatus: 'not_required',
        },
        {
          criterionId: 'criterion-not-met-mismatch', criterionText: 'Reviewer disagrees',
          criterionKind: 'inclusion', assessment: 'not_met',
          explanation: 'Explanation B', evidence: [], evidenceValidationStatus: 'not_required',
        },
        {
          criterionId: 'criterion-unclear', criterionText: 'LLM is unclear',
          criterionKind: 'inclusion', assessment: 'unclear',
          explanation: 'Explanation C', evidence: [], evidenceValidationStatus: 'not_required',
        },
        {
          criterionId: 'criterion-unanswered', criterionText: 'Reviewer has not answered yet',
          criterionKind: 'inclusion', assessment: 'met',
          explanation: 'Explanation D', evidence: [], evidenceValidationStatus: 'not_required',
        },
      ],
    }))
    renderWithProviders(
      <ScreeningLlmPanel
        projectId="project-1"
        publicationId="publication-1"
        itemId="item-1"
        stage="full_text"
        criteriaAnswers={{
          'criterion-met-match': true,
          'criterion-not-met-mismatch': true,
          'criterion-unclear': true,
        }}
        criteria={[
          { id: 'criterion-met-match', kind: 'inclusion', text: 'Reviewer agrees it is met' },
          { id: 'criterion-not-met-mismatch', kind: 'inclusion', text: 'Reviewer disagrees' },
          { id: 'criterion-unclear', kind: 'inclusion', text: 'LLM is unclear' },
          { id: 'criterion-unanswered', kind: 'inclusion', text: 'Reviewer has not answered yet' },
        ]}
      />,
    )

    const matchRow = (await screen.findByText(/Reviewer agrees it is met/)).closest('details') as HTMLElement
    expect(matchRow).toHaveClass('llm-criterion--match')
    expect(within(matchRow).getByText('IC1')).toHaveClass('criterion-badge--inclusion')

    const mismatchRow = screen.getByText(/Reviewer disagrees/).closest('details') as HTMLElement
    expect(mismatchRow).toHaveClass('llm-criterion--mismatch')
    expect(within(mismatchRow).getByText(/Differs from your answer/)).toBeInTheDocument()
    expect(within(mismatchRow).getByText('IC2')).toBeInTheDocument()

    const unclearRow = screen.getByText(/LLM is unclear/).closest('details') as HTMLElement
    expect(unclearRow).not.toHaveClass('llm-criterion--match')
    expect(unclearRow).not.toHaveClass('llm-criterion--mismatch')

    const unansweredRow = screen.getByText(/Reviewer has not answered yet/).closest('details') as HTMLElement
    expect(unansweredRow).not.toHaveClass('llm-criterion--match')
    expect(unansweredRow).not.toHaveClass('llm-criterion--mismatch')
  })

  it('offers an Apply suggestion button only for mismatched criteria when setCriteriaAnswers is provided', async () => {
    mockFetch(async () => jsonResponse({
      state: 'ready', hidden: false, stale: false, suggestedDecision: 'include',
      confidence: 'medium', reasoningSummary: 'Mixed criteria results.',
      criteria: [
        {
          criterionId: 'criterion-match', criterionText: 'Reviewer agrees it is met',
          criterionKind: 'inclusion', assessment: 'met',
          explanation: 'Explanation A', evidence: [], evidenceValidationStatus: 'not_required',
        },
        {
          criterionId: 'criterion-mismatch', criterionText: 'Reviewer disagrees',
          criterionKind: 'inclusion', assessment: 'not_met',
          explanation: 'Explanation B', evidence: [], evidenceValidationStatus: 'not_required',
        },
      ],
    }))
    const setCriteriaAnswers = vi.fn()
    renderWithProviders(
      <ScreeningLlmPanel
        projectId="project-1"
        publicationId="publication-1"
        itemId="item-1"
        stage="full_text"
        criteriaAnswers={{ 'criterion-match': true, 'criterion-mismatch': true }}
        criteria={[
          { id: 'criterion-match', kind: 'inclusion', text: 'Reviewer agrees it is met' },
          { id: 'criterion-mismatch', kind: 'inclusion', text: 'Reviewer disagrees' },
        ]}
        setCriteriaAnswers={setCriteriaAnswers}
      />,
    )

    const matchRow = (await screen.findByText(/Reviewer agrees it is met/)).closest('details') as HTMLElement
    expect(within(matchRow).queryByRole('button', { name: 'Apply suggestion' })).not.toBeInTheDocument()

    const mismatchRow = screen.getByText(/Reviewer disagrees/).closest('details') as HTMLElement
    fireEvent.click(within(mismatchRow).getByRole('button', { name: 'Apply suggestion' }))

    expect(setCriteriaAnswers).toHaveBeenCalledTimes(1)
    const updater = setCriteriaAnswers.mock.calls[0][0]
    expect(updater({ 'criterion-match': true, 'criterion-mismatch': true })).toEqual({
      'criterion-match': true,
      'criterion-mismatch': false,
    })
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
