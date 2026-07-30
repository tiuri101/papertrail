import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectDashboard } from '../ProjectDashboard'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectDashboard', () => {
  it('renders project workflow metrics', async () => {
    mockFetch(() => jsonResponse({
      stage: 'full_text_screening',
      records: 240,
      unresolvedConflicts: 3,
    }))
    renderWithProviders(<ProjectDashboard projectId="p1" />)

    expect(await screen.findByText('full_text_screening')).toBeInTheDocument()
    expect(screen.getByText('240')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('unresolvedConflicts')).toBeInTheDocument()
  })

  it('shows an error state when status cannot be loaded', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Unavailable' } }, 500))
    renderWithProviders(<ProjectDashboard projectId="p1" />)
    expect(await screen.findByText('Project status could not be loaded.')).toBeInTheDocument()
  })
})
