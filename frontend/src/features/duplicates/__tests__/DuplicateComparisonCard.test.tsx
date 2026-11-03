import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderWithProviders } from '../../../test/render'
import { DuplicateComparisonCard } from '../DuplicateComparisonCard'
import type { Candidate, ProviderRecommendation } from '../types'

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    publicationA: {
      id: 'pub-a',
      title: 'Record A',
      authors: 'Alice',
      publicationYear: 2024,
      venue: 'CHI',
      doi: '10.1/a',
      publisherUrl: 'https://publisher.example/a',
      screened: false,
      urlChecks: [
        { kind: 'publisher_url', url: 'https://a.invalid', reachable: true, statusCode: 200, checkedAt: '2026-08-27T00:00:00Z' },
        { kind: 'doi', url: 'https://doi.org/10.1/a', reachable: false, statusCode: 404, checkedAt: '2026-08-27T00:00:00Z' },
      ],
    },
    publicationB: {
      id: 'pub-b',
      title: 'Record B',
      authors: 'Alice',
      publicationYear: 2024,
      venue: 'CHI',
      doi: '10.1/b',
      publisherUrl: null,
      screened: false,
      urlChecks: [],
    },
    matchReasons: ['similar_title'],
    titleSimilarity: 95,
    authorSimilarity: 90,
    yearAgreement: true,
    confidence: 0.9,
    status: 'unresolved',
    autoResolved: false,
    resolvedById: null,
    resolvedByName: null,
    resolvedAt: null,
    resolutionNote: null,
    canonicalPublicationId: null,
    mergeId: null,
    reservedUntil: null,
    reservedById: null,
    providerRecommendation: null,
    providerRecommendedCanonicalId: null,
    providerRecommendationReason: null,
    providerRecommendationSource: null,
    ...overrides,
  }
}

describe('DuplicateComparisonCard', () => {
  it('renders a reachability badge per checked URL', () => {
    renderWithProviders(<DuplicateComparisonCard candidate={candidate()} />)
    expect(screen.getByText(/Publisher link: Reachable/)).toBeInTheDocument()
    expect(screen.getByText(/DOI link: Unreachable/)).toBeInTheDocument()
  })

  it('shows a publisher link pill when the record has one', () => {
    renderWithProviders(<DuplicateComparisonCard candidate={candidate()} />)
    const pill = screen.getByRole('link', { name: 'Publisher link' })
    expect(pill).toHaveAttribute('href', 'https://publisher.example/a')
  })

  it('shows the provider "keep record A" recommendation with its reason', () => {
    renderWithProviders(
      <DuplicateComparisonCard
        candidate={candidate({
          providerRecommendation: 'merge',
          providerRecommendedCanonicalId: 'pub-a',
          providerRecommendationReason: "Record B's DOI returns no record.",
          providerRecommendationSource: 'crossref',
        })}
      />,
    )
    expect(screen.getByText('Suggested: keep Record A')).toBeInTheDocument()
    expect(screen.getByText(/returns no record.*via Crossref/)).toBeInTheDocument()
  })

  it.each<ProviderRecommendation | null>(['uncertain', null])(
    'shows no recommendation callout for %s',
    (recommendation) => {
      renderWithProviders(
        <DuplicateComparisonCard
          candidate={candidate({ providerRecommendation: recommendation })}
        />,
      )
      expect(screen.queryByText(/^Suggested:/)).not.toBeInTheDocument()
    },
  )

  it('hides the recommendation once the pair is resolved', () => {
    renderWithProviders(
      <DuplicateComparisonCard
        candidate={candidate({
          status: 'merged',
          providerRecommendation: 'merge',
          providerRecommendedCanonicalId: 'pub-a',
          providerRecommendationReason: 'because',
        })}
      />,
    )
    expect(screen.queryByText('Suggested: keep Record A')).not.toBeInTheDocument()
  })

  it('marks only the record that already has screening decisions', () => {
    const base = candidate()
    renderWithProviders(
      <DuplicateComparisonCard
        candidate={candidate({ publicationA: { ...base.publicationA, screened: true } })}
      />,
    )
    const recordA = screen.getByText('Record A', { selector: 'p' }).closest('section')!
    const recordB = screen.getByText('Record B', { selector: 'p' }).closest('section')!
    expect(within(recordA).getByText('Screened')).toBeInTheDocument()
    expect(within(recordB).queryByText('Screened')).not.toBeInTheDocument()
  })
})
