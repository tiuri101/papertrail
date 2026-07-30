import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectDashboard } from '../ProjectDashboard'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectDashboard', () => {
  it('renders project workflow metrics as a table, excluding the stage (shown separately above)', async () => {
    mockFetch(() => jsonResponse({
      stage: 'full_text_screening',
      records: 240,
      unresolvedConflicts: 3,
    }))
    renderWithProviders(<ProjectDashboard projectId="p1" />)

    const table = await screen.findByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Metric' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Value' })).toBeInTheDocument()

    expect(within(table).queryByRole('rowheader', { name: 'Stage' })).not.toBeInTheDocument()
    expect(within(table).queryByText('full_text_screening')).not.toBeInTheDocument()

    const recordsRow = within(table).getByRole('rowheader', { name: 'Records' }).closest('tr') as HTMLElement
    expect(within(recordsRow).getByText('240')).toBeInTheDocument()

    const conflictsRow = within(table).getByRole('rowheader', { name: 'Unresolved conflicts' }).closest('tr') as HTMLElement
    expect(within(conflictsRow).getByText('3')).toBeInTheDocument()
  })

  it('shows an error state when status cannot be loaded', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Unavailable' } }, 500))
    renderWithProviders(<ProjectDashboard projectId="p1" />)
    expect(await screen.findByText('Project status could not be loaded.')).toBeInTheDocument()
  })
})
