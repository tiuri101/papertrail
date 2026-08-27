import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { DuplicateReviewSection } from '../DuplicateReviewSection'

vi.mock('../FieldBarChart', () => ({
  FieldBarChart: ({ data }: { data: { label: string; count: number }[] }) => (
    <ul data-testid="bar-chart">
      {data.map((item) => (
        <li key={item.label}>{item.label}: {item.count}</li>
      ))}
    </ul>
  ),
}))

const response = {
  stats: {
    recordsIdentified: 20,
    duplicatesRemoved: 5,
    uniqueRecordsRemaining: 15,
    matchReasonCounts: [
      { label: 'exact_doi', count: 3 },
      { label: 'similar_title_authors', count: 2 },
      { label: 'provider_confirmed', count: 1 },
    ],
  },
  narrative: null,
  isStale: false,
  narrativeEnabled: false,
}

describe('DuplicateReviewSection', () => {
  it('renders match reasons as human-readable labels, not raw codes', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/analysis/duplicate_review')) return jsonResponse(response)
      throw new Error(`unexpected request: ${input}`)
    })

    renderWithProviders(<DuplicateReviewSection projectId="p1" />, {
      route: '/projects/p1/analysis',
      path: '/projects/:projectId/analysis',
    })

    expect(await screen.findByText('Exact DOI: 3')).toBeInTheDocument()
    expect(screen.getByText('Similar title & authors: 2')).toBeInTheDocument()
    expect(screen.getByText('Confirmed by Crossref / Semantic Scholar: 1')).toBeInTheDocument()
    expect(screen.queryByText(/exact_doi/)).not.toBeInTheDocument()
    expect(screen.queryByText(/similar_title_authors/)).not.toBeInTheDocument()
  })
})
