import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MyExtractionsPage } from '../MyExtractionsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('MyExtractionsPage', () => {
  it('lists the reviewer completed extractions with a link to revisit each one', async () => {
    mockFetch(async (input) => (
      String(input).endsWith('/extraction/mine')
        ? jsonResponse([
          {
            id: 'extraction-1',
            publicationId: 'publication-1',
            publication: { title: 'Immersive Urban Analytics', authors: 'A. Author', publicationYear: 2024 },
            completedAt: '2026-08-01T12:00:00Z',
            version: 2,
          },
        ])
        : jsonResponse({})
    ))
    renderWithProviders(<MyExtractionsPage />, {
      route: '/projects/p1/extraction/mine',
      path: '/projects/:projectId/extraction/mine',
    })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByText(/Version 2/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review and edit' })).toHaveAttribute(
      'href',
      '/projects/p1/extraction/review/extraction-1',
    )
  })

  it('reports when nothing has been submitted yet', async () => {
    mockFetch(async () => jsonResponse([]))
    renderWithProviders(<MyExtractionsPage />, {
      route: '/projects/p1/extraction/mine',
      path: '/projects/:projectId/extraction/mine',
    })

    expect(await screen.findByText('You have not submitted any extractions yet.')).toBeInTheDocument()
  })
})
