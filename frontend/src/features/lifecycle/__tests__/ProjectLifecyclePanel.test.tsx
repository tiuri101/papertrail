import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectLifecyclePanel } from '../ProjectLifecyclePanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectLifecyclePanel', () => {
  it('shows integrity issues and reopens at the selected stage', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/reopen') && init?.method === 'POST') return jsonResponse({ stage: 'duplicate_review' })
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [{ code: 'unresolved_duplicates', message: 'Two duplicate candidates remain.' }] })
      return jsonResponse({ stage: 'completed' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)

    expect(await screen.findByText('Two duplicate candidates remain.')).toBeInTheDocument()
    const integritySection = screen.getByRole('heading', { name: 'Workflow Integrity' }).closest('section')
    const reopenSection = screen.getByRole('heading', { name: 'Reopen Project' }).closest('section')
    expect(integritySection).toHaveClass('card')
    expect(reopenSection).toHaveClass('card')
    expect(reopenSection).not.toBe(integritySection)
    expect(screen.getByRole('option', { name: 'Duplicate Review' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Move back to'), { target: { value: 'duplicate_review' } })
    const reopenButtons = within(reopenSection as HTMLElement).getAllByRole(
      'button',
      { name: 'Reopen Project' },
    )
    fireEvent.click(reopenButtons.find((button) => !button.hasAttribute('aria-expanded'))!)

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(call?.[0]).toBe('/api/v1/projects/p1/reopen')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ targetStage: 'duplicate_review' })
    expect(screen.queryByRole('button', { name: 'Mark Project Ready' })).not.toBeInTheDocument()
  })

  it('reports a clean project', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [] })
      return jsonResponse({ stage: 'title_abstract_screening' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)
    expect(await screen.findByText('No consistency issues detected.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Reopen Project' })).not.toBeInTheDocument()
  })

  it('only offers stages before the current stage when moving an in-progress project back', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [] })
      return jsonResponse({ stage: 'full_text_screening' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)

    const moveBackSection = (await screen.findByRole('heading', { name: 'Move Project Back' }))
      .closest('section')
    const integritySection = screen.getByRole('heading', { name: 'Workflow Integrity' })
      .closest('section')
    expect(moveBackSection).toHaveClass('card')
    expect(integritySection).toHaveClass('card')
    expect(moveBackSection).not.toBe(integritySection)
    expect(screen.getByRole('option', { name: 'Duplicate Review' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Title Abstract Screening' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Extraction Quality' })).not.toBeInTheDocument()
  })
})
