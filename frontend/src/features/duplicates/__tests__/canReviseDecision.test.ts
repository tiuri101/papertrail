import { describe, expect, it } from 'vitest'

import { type Candidate, canReviseDecision } from '../types'

function record(id: string, screened: boolean) {
  return {
    id,
    title: id,
    authors: null,
    publicationYear: null,
    venue: null,
    doi: null,
    publisherUrl: null,
    screened,
    urlChecks: [],
  }
}

function merged(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'c1',
    publicationA: record('pub-a', true),
    publicationB: record('pub-b', false),
    matchReasons: [],
    titleSimilarity: null,
    authorSimilarity: null,
    yearAgreement: null,
    confidence: 0.9,
    status: 'merged',
    autoResolved: false,
    resolvedById: null,
    resolvedByName: null,
    resolvedAt: null,
    resolutionNote: null,
    canonicalPublicationId: 'pub-a',
    mergeId: 'm1',
    mergeStage: 'title_abstract_screening',
    reservedUntil: null,
    reservedById: null,
    providerRecommendation: null,
    providerRecommendedCanonicalId: null,
    providerRecommendationReason: null,
    providerRecommendationSource: null,
    ...overrides,
  }
}

describe('canReviseDecision', () => {
  it('allows every change during duplicate review', () => {
    expect(canReviseDecision(merged({ mergeStage: null }), 'duplicate_review')).toBe(true)
  })

  it('allows undoing a merge in the screening stage it was made in', () => {
    expect(canReviseDecision(merged(), 'title_abstract_screening')).toBe(true)
  })

  it('refuses a merge made in an earlier stage', () => {
    expect(canReviseDecision(merged({ mergeStage: null }), 'title_abstract_screening')).toBe(false)
    expect(canReviseDecision(merged(), 'full_text_screening')).toBe(false)
  })

  it('refuses a merge whose merged-away record had screening decisions', () => {
    const candidate = merged({ publicationB: record('pub-b', true) })
    expect(canReviseDecision(candidate, 'title_abstract_screening')).toBe(false)
  })

  it('allows revising a "not duplicate" decision during screening', () => {
    const candidate = merged({ status: 'not_duplicate', canonicalPublicationId: null, mergeId: null })
    expect(canReviseDecision(candidate, 'full_text_screening')).toBe(true)
  })

  it('refuses everything outside stages that take duplicate decisions', () => {
    expect(canReviseDecision(merged(), 'draft')).toBe(false)
  })
})
