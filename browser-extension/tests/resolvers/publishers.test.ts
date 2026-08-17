import { describe, expect, it } from 'vitest'

import { acmResolver } from '../../src/resolvers/acm'
import { ieeeResolver } from '../../src/resolvers/ieee'
import { scienceDirectResolver } from '../../src/resolvers/sciencedirect'
import { springerResolver } from '../../src/resolvers/springer'
import { loadFixtureHtml, parseFixture } from '../fixture'

function contextFor(fixture: string, landingUrl: string) {
  return {
    landingUrl,
    html: loadFixtureHtml(fixture),
    document: parseFixture(fixture),
  }
}

describe('acmResolver', () => {
  const landingUrl = 'https://dl.acm.org/doi/10.1145/1234567.1234568'

  it('handles dl.acm.org and not other hosts', () => {
    expect(acmResolver.canHandle(contextFor('acm-landing.html', landingUrl))).toBe(true)
    expect(acmResolver.canHandle(contextFor('acm-landing.html', 'https://example.org/doi/10.1145/1'))).toBe(false)
  })

  it('derives the PDF URL from the DOI path in the landing URL', () => {
    const candidates = acmResolver.discover(contextFor('acm-landing.html', landingUrl))
    expect(candidates.some((c) => c.url === 'https://dl.acm.org/doi/pdf/10.1145/1234567.1234568')).toBe(true)
  })
})

describe('ieeeResolver', () => {
  const landingUrl = 'https://ieeexplore.ieee.org/document/9876543'

  it('handles ieeexplore.ieee.org and not other hosts', () => {
    expect(ieeeResolver.canHandle(contextFor('ieee-landing.html', landingUrl))).toBe(true)
    expect(ieeeResolver.canHandle(contextFor('ieee-landing.html', 'https://example.org/document/1'))).toBe(false)
  })

  it('falls back to the direct-download getPDF URL using the article number', () => {
    const candidates = ieeeResolver.discover(contextFor('ieee-landing.html', landingUrl))
    expect(
      candidates.some(
        (c) => c.url.includes('/stampPDF/getPDF.jsp') && c.url.includes('arnumber=9876543'),
      ),
    ).toBe(true)
    // stamp.jsp only ever returns IEEE's HTML viewer, never PDF bytes -- it
    // must never be offered as a candidate.
    expect(candidates.some((c) => c.url.includes('/stamp/stamp.jsp'))).toBe(false)
  })

  it('includes isnumber from the landing URL when present', () => {
    const candidates = ieeeResolver.discover(
      contextFor('ieee-landing.html', 'https://ieeexplore.ieee.org/document/9876543?isnumber=1234567'),
    )
    expect(candidates.some((c) => c.url.includes('isnumber=1234567'))).toBe(true)
  })
})

describe('springerResolver', () => {
  const landingUrl = 'https://link.springer.com/article/10.1007/s00000-000-0000-0'

  it('handles link.springer.com and not other hosts', () => {
    expect(springerResolver.canHandle(contextFor('springer-landing.html', landingUrl))).toBe(true)
    expect(springerResolver.canHandle(contextFor('springer-landing.html', 'https://example.org/article/1'))).toBe(false)
  })

  it('finds the citation_pdf_url and the download-pdf link', () => {
    const candidates = springerResolver.discover(contextFor('springer-landing.html', landingUrl))
    const urls = candidates.map((c) => c.url)
    expect(urls).toContain('https://link.springer.com/content/pdf/10.1007/s00000-000-0000-0.pdf')
  })
})

describe('scienceDirectResolver', () => {
  const landingUrl = 'https://www.sciencedirect.com/science/article/pii/S0000000000000000'

  it('handles sciencedirect.com and not other hosts', () => {
    expect(scienceDirectResolver.canHandle(contextFor('sciencedirect-landing.html', landingUrl))).toBe(true)
    expect(scienceDirectResolver.canHandle(contextFor('sciencedirect-landing.html', 'https://example.org/pii/1'))).toBe(false)
  })

  it('finds the pdfft download link', () => {
    const candidates = scienceDirectResolver.discover(contextFor('sciencedirect-landing.html', landingUrl))
    expect(candidates.some((c) => c.url.includes('/pdfft?'))).toBe(true)
  })
})
