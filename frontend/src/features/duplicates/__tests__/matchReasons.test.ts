import { describe, expect, it } from 'vitest'

import { humanizeMatchReason } from '../matchReasons'

describe('humanizeMatchReason', () => {
  it('labels the provider-confirmed reason', () => {
    expect(humanizeMatchReason('provider_confirmed')).toBe(
      'Confirmed by Crossref / Semantic Scholar',
    )
  })

  it('falls back to a de-underscored string for unknown reasons', () => {
    expect(humanizeMatchReason('some_new_reason')).toBe('some new reason')
  })
})
