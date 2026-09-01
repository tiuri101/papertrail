import { fireEvent, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '../../../test/render'
import type { ScreeningAssistance } from '../../llm/LlmTaskComponents'
import { CriteriaAnswerFields } from '../CriteriaAnswerFields'
import type { CriterionAnswer, ScreeningCriterion } from '../useScreeningQueue'

const criteria: ScreeningCriterion[] = [
  { id: 'criterion-1', kind: 'inclusion', text: 'Reports an evaluation' },
]

function Harness({
  criteria: criteriaProp,
  initialAnswers,
  llmData,
  stage = 'full_text',
  onApplySuggestion,
}: {
  criteria: ScreeningCriterion[]
  initialAnswers: Record<string, CriterionAnswer>
  llmData?: ScreeningAssistance
  stage?: 'title_abstract' | 'full_text'
  onApplySuggestion?: (criterionId: string, met: boolean) => void
}) {
  const [answers, setAnswers] = useState(initialAnswers)
  const [outcome, setOutcome] = useState('include')
  const [notes, setNotes] = useState('')
  return (
    <CriteriaAnswerFields
      criteria={criteriaProp}
      answers={answers}
      setAnswers={setAnswers}
      outcome={outcome}
      setOutcome={setOutcome}
      notes={notes}
      setNotes={setNotes}
      llm={llmData !== undefined ? {
        data: llmData,
        stage,
        projectId: 'project-1',
        publicationId: 'publication-1',
        onApplySuggestion,
      } : undefined}
    />
  )
}

function readyAssistance(overrides: Partial<ScreeningAssistance> = {}): ScreeningAssistance {
  return {
    state: 'ready',
    hidden: false,
    runId: 'run-1',
    documentId: null,
    model: null,
    promptVersion: null,
    stale: false,
    error: null,
    suggestedDecision: 'include',
    confidence: 'high',
    reasoningSummary: null,
    criteria: [],
    ...overrides,
  }
}

describe('CriteriaAnswerFields', () => {
  it('renders exactly like the plain criteria table when no LLM data is available', () => {
    renderWithProviders(<Harness criteria={criteria} initialAnswers={{ 'criterion-1': null }} />)

    const row = screen.getByText('Reports an evaluation').closest('tr') as HTMLElement
    expect(row.className).not.toMatch(/bg-(success|danger)-container/)
    expect(row).not.toHaveAttribute('tabindex')
    expect(screen.queryByTitle(/LLM suggestion available/)).not.toBeInTheDocument()
  })

  it('renders the plain table while the suggestion is still hidden or loading', () => {
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': null }}
        llmData={{ ...readyAssistance(), state: 'hidden', hidden: true }}
      />,
    )

    const row = screen.getByText('Reports an evaluation').closest('tr') as HTMLElement
    expect(row.className).not.toMatch(/bg-(success|danger)-container/)
    expect(screen.queryByTitle(/LLM suggestion available/)).not.toBeInTheDocument()
  })

  it('colors a row green when the reviewer answer matches the LLM assessment', () => {
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': true }}
        llmData={readyAssistance({
          criteria: [{
            criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
            criterionKind: 'inclusion', assessment: 'met',
            explanation: 'A study is reported.', evidence: [], evidenceValidationStatus: 'not_required',
          }],
        })}
      />,
    )

    const row = screen.getByText('Reports an evaluation').closest('tr') as HTMLElement
    expect(row.className).toMatch(/bg-success-container/)
    expect(screen.getByTitle(/LLM suggestion available/)).toBeInTheDocument()
  })

  it('colors a row red, and expanding it shows the explanation and an Apply suggestion button, when they differ', () => {
    const onApplySuggestion = vi.fn()
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': true }}
        stage="full_text"
        onApplySuggestion={onApplySuggestion}
        llmData={readyAssistance({
          criteria: [{
            criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
            criterionKind: 'inclusion', assessment: 'not_met',
            explanation: 'No evaluation is reported.',
            evidence: [{ page: 3, section: 'Results', quote: 'No study was run.', verified: true }],
            evidenceValidationStatus: 'verified',
          }],
        })}
      />,
    )

    const row = screen.getByText('Reports an evaluation').closest('tr') as HTMLElement
    expect(row.className).toMatch(/bg-danger-container/)
    expect(screen.queryByText('No evaluation is reported.')).not.toBeInTheDocument()

    fireEvent.click(row)
    expect(screen.getByText('No evaluation is reported.')).toBeInTheDocument()
    expect(screen.getByText(/Verified evidence/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }))
    expect(onApplySuggestion).toHaveBeenCalledWith('criterion-1', false)
  })

  it('does not show evidence for title/abstract screening, but still offers Apply suggestion', () => {
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': true }}
        stage="title_abstract"
        onApplySuggestion={vi.fn()}
        llmData={readyAssistance({
          criteria: [{
            criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
            criterionKind: 'inclusion', assessment: 'not_met',
            explanation: 'The abstract does not mention an evaluation.',
            evidence: [{ page: 1, section: null, quote: 'irrelevant', verified: false }],
            evidenceValidationStatus: 'not_required',
          }],
        })}
      />,
    )

    fireEvent.click(screen.getByText('Reports an evaluation').closest('tr') as HTMLElement)
    expect(screen.getByText('The abstract does not mention an evaluation.')).toBeInTheDocument()
    expect(screen.queryByText(/Verified evidence|Unverified evidence/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply suggestion' })).toBeInTheDocument()
  })

  it('does not offer an Apply suggestion button when no handler is provided', () => {
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': true }}
        llmData={readyAssistance({
          criteria: [{
            criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
            criterionKind: 'inclusion', assessment: 'not_met',
            explanation: 'No evaluation is reported.', evidence: [], evidenceValidationStatus: 'not_required',
          }],
        })}
      />,
    )

    fireEvent.click(screen.getByText('Reports an evaluation').closest('tr') as HTMLElement)
    expect(screen.getByText('No evaluation is reported.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply suggestion' })).not.toBeInTheDocument()
  })

  it('leaves a row uncolored and clickable when the LLM assessment is unclear', () => {
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': true }}
        llmData={readyAssistance({
          criteria: [{
            criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
            criterionKind: 'inclusion', assessment: 'unclear',
            explanation: 'The text is ambiguous.', evidence: [], evidenceValidationStatus: 'not_required',
          }],
        })}
      />,
    )

    const row = screen.getByText('Reports an evaluation').closest('tr') as HTMLElement
    expect(row.className).not.toMatch(/bg-(success|danger)-container/)
    fireEvent.click(row)
    expect(screen.getByText('The text is ambiguous.')).toBeInTheDocument()
    expect(within(row.parentElement as HTMLElement).queryByRole('button', { name: 'Apply suggestion' })).not.toBeInTheDocument()
  })

  it('toggles via Enter without blocking the global submit hotkey from also seeing the keydown', () => {
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': true }}
        llmData={readyAssistance({
          criteria: [{
            criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
            criterionKind: 'inclusion', assessment: 'met',
            explanation: 'A study is reported.', evidence: [], evidenceValidationStatus: 'not_required',
          }],
        })}
      />,
    )

    const row = screen.getByText('Reports an evaluation').closest('tr') as HTMLElement
    // fireEvent's return value mirrors native dispatchEvent: true means the
    // event's default was NOT prevented.
    const notPrevented = fireEvent.keyDown(row, { key: 'Enter' })

    expect(screen.getByText('A study is reported.')).toBeInTheDocument()
    // useScreeningDecisionHotkeys bails out on `event.defaultPrevented` once its
    // window listener sees the bubbled event -- Enter must not set that flag,
    // or the "Confirm Decision" hotkey would never fire while a row has focus.
    expect(notPrevented).toBe(true)
  })

  it('still prevents Space from scrolling the page while toggling the row', () => {
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': true }}
        llmData={readyAssistance({
          criteria: [{
            criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
            criterionKind: 'inclusion', assessment: 'met',
            explanation: 'A study is reported.', evidence: [], evidenceValidationStatus: 'not_required',
          }],
        })}
      />,
    )

    const row = screen.getByText('Reports an evaluation').closest('tr') as HTMLElement
    const notPrevented = fireEvent.keyDown(row, { key: ' ' })

    expect(screen.getByText('A study is reported.')).toBeInTheDocument()
    expect(notPrevented).toBe(false)
  })

  it('does not let a checkbox click bubble into toggling the LLM explanation row', () => {
    renderWithProviders(
      <Harness
        criteria={criteria}
        initialAnswers={{ 'criterion-1': null }}
        llmData={readyAssistance({
          criteria: [{
            criterionId: 'criterion-1', criterionText: 'Reports an evaluation',
            criterionKind: 'inclusion', assessment: 'met',
            explanation: 'A study is reported.', evidence: [], evidenceValidationStatus: 'not_required',
          }],
        })}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: /Fulfilled/ }))
    expect(screen.queryByText('A study is reported.')).not.toBeInTheDocument()
  })
})
