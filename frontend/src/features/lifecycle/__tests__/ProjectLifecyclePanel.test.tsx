import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectLifecyclePanel } from '../ProjectLifecyclePanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectLifecyclePanel', () => {
  it('shows integrity issues for the project', async () => {
    mockFetch(async () => jsonResponse({ issues: [{ code: 'unresolved_duplicates', message: 'Two duplicate candidates remain.' }] }))
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)

    expect(await screen.findByText('Two duplicate candidates remain.')).toBeInTheDocument()
    const integrityHeading = screen.getByRole('heading', { name: 'Workflow Integrity' })
    expect(integrityHeading.closest('section')).toBeInTheDocument()
  })

  it('reports a clean project', async () => {
    mockFetch(() => jsonResponse({ issues: [] }))
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)
    expect(await screen.findByText('No consistency issues detected.')).toBeInTheDocument()
  })
})
