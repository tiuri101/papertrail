import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MyQualityPage } from '../MyQualityPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('MyQualityPage', () => {
  it('lists the reviewer completed assessments with a link to revisit each one', async () => {
    mockFetch(async (input) => (
      String(input).endsWith('/quality/mine')
        ? jsonResponse([
          {
            id: 'quality-1',
            publicationId: 'publication-1',
            publication: { title: 'Immersive Urban Analytics', authors: 'A. Author', publicationYear: 2024 },
            completedAt: '2026-08-01T12:00:00Z',
            version: 1,
            totalScore: 8,
          },
        ])
        : jsonResponse({})
    ))
    renderWithProviders(<MyQualityPage />, {
      route: '/projects/p1/quality/mine',
      path: '/projects/:projectId/quality/mine',
    })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByText(/Total score 8/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review and edit' })).toHaveAttribute(
      'href',
      '/projects/p1/quality/review/quality-1',
    )
  })

  it('reports when nothing has been submitted yet', async () => {
    mockFetch(async () => jsonResponse([]))
    renderWithProviders(<MyQualityPage />, {
      route: '/projects/p1/quality/mine',
      path: '/projects/:projectId/quality/mine',
    })

    expect(await screen.findByText('You have not submitted any quality assessments yet.')).toBeInTheDocument()
  })
})
