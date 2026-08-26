import { describe, expect, it } from 'vitest'

import {
  EXTRACTION_STATUSES,
  extractionStatusLabel,
  extractionStatusVariant,
  isExtractionComplete,
  isExtractionInFlight,
} from '../extractionStatus'
import { primaryStage, type Publication } from '../../publications/publicationShared'

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: 'publication-1',
    title: 'Urban Data in VR',
    authors: null,
    abstract: null,
    publicationYear: null,
    venue: null,
    publicationType: null,
    doi: null,
    publisherUrl: null,
    keywords: null,
    isbn: null,
    issn: null,
    pubmedId: null,
    arxivId: null,
    fullText: { available: true },
    screeningStatus: { titleAbstract: 'include', fullText: 'include' },
    extractionStatus: 'not_started',
    ...overrides,
  }
}

describe('extraction status', () => {
  it('labels every value the API can send', () => {
    expect(EXTRACTION_STATUSES.map(extractionStatusLabel)).toEqual([
      'Not started',
      'Available',
      'In progress',
      'Awaiting second reviewer',
      'Awaiting reconciliation',
      'Completed',
    ])
    EXTRACTION_STATUSES.forEach((status) => {
      expect(extractionStatusVariant(status)).toBeTruthy()
    })
  })

  it('treats a valid final result as the only completed state', () => {
    expect(isExtractionComplete('completed')).toBe(true)
    // Both reviewers submitted but disagreed: no authoritative result exists.
    expect(isExtractionComplete('awaiting_reconciliation')).toBe(false)
    expect(isExtractionComplete('awaiting_second_reviewer')).toBe(false)
    expect(extractionStatusVariant('completed')).toBe('success')
  })

  it('counts every started-but-unresolved state as in flight', () => {
    expect(isExtractionInFlight('available')).toBe(true)
    expect(isExtractionInFlight('in_progress')).toBe(true)
    expect(isExtractionInFlight('awaiting_second_reviewer')).toBe(true)
    expect(isExtractionInFlight('awaiting_reconciliation')).toBe(true)
    expect(isExtractionInFlight('not_started')).toBe(false)
    expect(isExtractionInFlight('completed')).toBe(false)
  })

  // Regression: the badge used to be derived from a single work-item slot, so
  // a dual extraction with one reviewer done and the other slot untouched --
  // and one awaiting reconciliation -- were indistinguishable from finished.
  it('keeps a publication out of "Included" until extraction actually resolves', () => {
    expect(primaryStage(publication({ extractionStatus: 'awaiting_second_reviewer' })))
      .toEqual({ label: 'Extraction', variant: 'warning' })
    expect(primaryStage(publication({ extractionStatus: 'awaiting_reconciliation' })))
      .toEqual({ label: 'Extraction', variant: 'warning' })
    expect(primaryStage(publication({ extractionStatus: 'in_progress' })))
      .toEqual({ label: 'Extraction', variant: 'warning' })
    expect(primaryStage(publication({ extractionStatus: 'completed' })))
      .toEqual({ label: 'Included', variant: 'success' })
  })

  it('reads a publication with no extraction slots as simply included', () => {
    // `not_started` is what the API now sends where it used to send null.
    expect(primaryStage(publication({ extractionStatus: 'not_started' })))
      .toEqual({ label: 'Included', variant: 'success' })
  })
})
