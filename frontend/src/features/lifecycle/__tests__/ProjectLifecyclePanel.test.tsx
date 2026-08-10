import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectLifecyclePanel } from '../ProjectLifecyclePanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectLifecyclePanel', () => {
  it('shows integrity issues for the project', async () => {
    mockFetch(async (input) => {
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [{ code: 'unresolved_duplicates', message: 'Two duplicate candidates remain.' }] })
      return jsonResponse({ stage: 'completed' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)

    expect(await screen.findByText('Two duplicate candidates remain.')).toBeInTheDocument()
    const integrityHeading = screen.getByRole('heading', { name: 'Workflow Integrity' })
    expect(integrityHeading.closest('section')).toHaveClass('card')
    expect(screen.queryByRole('button', { name: 'Mark Project Ready' })).not.toBeInTheDocument()
  })

  it('reports a clean project', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [] })
      return jsonResponse({ stage: 'title_abstract_screening' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)
    expect(await screen.findByText('No consistency issues detected.')).toBeInTheDocument()
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
