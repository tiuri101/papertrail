import { describe, expect, it } from 'vitest'

import { looksLikeLoginOrPaywallPage } from '../src/retrieval/response-classifier'

describe('looksLikeLoginOrPaywallPage', () => {
  it('detects a generic sign-in page', () => {
    expect(looksLikeLoginOrPaywallPage('<html><body>Please sign in to continue</body></html>')).toBe(true)
  })

  it('detects an institutional/Shibboleth login page', () => {
    expect(looksLikeLoginOrPaywallPage('<html><body>Select your institution (Shibboleth) to log in</body></html>')).toBe(true)
  })

  it('detects a paywall/purchase page', () => {
    expect(looksLikeLoginOrPaywallPage('<html><body>Purchase this article for $39.95</body></html>')).toBe(true)
  })

  it('does not flag a normal landing page with an abstract', () => {
    const html = '<html><body><h1>A Study of Urban Data</h1><p>We present a novel approach...</p></body></html>'
    expect(looksLikeLoginOrPaywallPage(html)).toBe(false)
  })
})
