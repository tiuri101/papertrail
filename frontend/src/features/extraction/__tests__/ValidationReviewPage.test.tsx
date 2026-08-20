import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ValidationReviewPage } from '../ValidationReviewPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ValidationReviewPage', () => {
  it('lists non-supported validation results and links to the human extraction revision', async () => {
    mockFetch(() => jsonResponse({
      enabled: true,
      progress: {
        total: 3,
        completed: 3,
        pending: 0,
        failed: 0,
        unavailable: 0,
        outstanding: 0,
        settled: true,
      },
      items: [
        {
          workItemId: 'item-1',
          publicationId: 'publication-1',
          assignedReviewerId: 'reviewer-1',
          responseId: 'response-1',
          submittedAt: '2026-01-01T12:30:00Z',
          fullTextAvailable: true,
          state: 'ready',
          runId: 'run-1',
          model: 'test-model',
          promptVersion: 'extraction_validation_v1',
          error: null,
          publication: {
            id: 'publication-1',
            title: 'Immersive Urban Analytics',
            authors: 'A. Author',
            publicationYear: 2024,
            venue: 'Journal of Urban Analytics',
            doi: '10.1000/urban',
          },
          results: [
            {
              fieldKey: 'sample-size',
              fieldLabel: 'Sample size',
              value: 22,
              assessment: 'contradicted',
              explanation: 'The paper reports 24 participants.',
              evidenceValidationStatus: 'verified',
              evidence: [{
                page: 8,
                section: 'Participants',
                quote: 'Twenty-four participants took part.',
                verified: true,
              }],
            },
          ],
        },
      ],
    }))

    renderWithProviders(<ValidationReviewPage />, {
      route: '/projects/p1/extraction/validation',
      path: '/projects/:projectId/extraction/validation',
    })

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Immersive Urban Analytics' })).toHaveAttribute(
      'href',
      '/projects/p1/publications/publication-1',
    )
    expect(screen.getByText('Journal of Urban Analytics (2024)')).toBeInTheDocument()
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-01-01T12:30:00Z')
    expect(screen.getByText('Human value:')).toHaveTextContent('22')
    expect(screen.getByText('contradicted')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Review and correct extraction' })).toHaveAttribute(
      'href',
      '/projects/p1/extraction/review/item-1',
    )
    expect(screen.getByRole('link', { name: 'View PDF' })).toHaveAttribute(
      'href',
      '/api/v1/projects/p1/publications/publication-1/full-text/content',
    )
  })

  it('explains when project validation is disabled', async () => {
    mockFetch(() => jsonResponse({
      enabled: false,
      progress: {
        total: 0,
        completed: 0,
        pending: 0,
        failed: 0,
        unavailable: 0,
        outstanding: 0,
        settled: true,
      },
      items: [],
    }))

    renderWithProviders(<ValidationReviewPage />, {
      route: '/projects/p1/extraction/validation',
      path: '/projects/:projectId/extraction/validation',
    })

    expect(await screen.findByText('LLM extraction validation is not enabled for this project.')).toBeInTheDocument()
  })
})
