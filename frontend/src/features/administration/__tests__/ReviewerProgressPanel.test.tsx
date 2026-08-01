import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReviewerProgressPanel } from '../ReviewerProgressPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const stages = [
  {
    stage: 'title_abstract',
    label: 'Title/Abstract Screening',
    reviewers: [
      { reviewerId: 'user-1', reviewerName: 'Reviewer One', assigned: 10, completed: 7 },
      { reviewerId: 'user-2', reviewerName: 'Reviewer Two', assigned: 5, completed: 5 },
    ],
  },
  {
    stage: 'full_text',
    label: 'Full-Text Screening',
    reviewers: [],
  },
]

describe('ReviewerProgressPanel', () => {
  it('shows assigned and completed counts per reviewer for each stage', async () => {
    mockFetch(() => jsonResponse(stages))
    renderWithProviders(<ReviewerProgressPanel projectId="p1" />)

    await screen.findByRole('heading', { name: 'Title/Abstract Screening' })
    const row = screen.getByText('Reviewer One').closest('tr') as HTMLElement
    expect(within(row).getByText('10')).toBeInTheDocument()
    expect(within(row).getByText('7')).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Full-Text Screening' })).toBeInTheDocument()
    expect(screen.getByText('No reviewers have been assigned work for this stage yet.')).toBeInTheDocument()
  })

  it('shows an error when the progress request fails', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Forbidden' } }, 403))
    renderWithProviders(<ReviewerProgressPanel projectId="p1" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden')
  })
})
