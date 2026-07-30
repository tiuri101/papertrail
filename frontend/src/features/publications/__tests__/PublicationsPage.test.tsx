import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PublicationsPage } from '../PublicationsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('PublicationsPage', () => {
  it('renders normalized bibliographic metadata and DOI links', async () => {
    mockFetch(() => jsonResponse([
      { id: 'publication-1', title: 'Urban Data in VR', authors: 'A. Author', publicationYear: 2025, doi: '10.1000/urban-vr' },
      { id: 'publication-2', title: 'Paper without DOI', authors: null, publicationYear: null, doi: null },
    ]))
    renderWithProviders(<PublicationsPage />, { route: '/projects/p1/publications', path: '/projects/:projectId/publications' })

    expect(await screen.findByText('Urban Data in VR')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'DOI' })).toHaveAttribute('href', 'https://doi.org/10.1000/urban-vr')
    expect(screen.getByText(/Paper without DOI/)).toHaveTextContent('Unknown authors')
  })
})
