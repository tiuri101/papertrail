import { describe, expect, it } from 'vitest'

import { genericResolver } from '../../src/resolvers/generic'
import { loadFixtureHtml, parseFixture } from '../fixture'

function contextFor(fixture: string, landingUrl: string) {
  return {
    landingUrl,
    html: loadFixtureHtml(fixture),
    document: parseFixture(fixture),
  }
}

describe('genericResolver', () => {
  it('always claims to handle a landing page', () => {
    expect(genericResolver.canHandle(contextFor('generic-no-candidate.html', 'https://x.example.org/'))).toBe(true)
  })

  it('prefers the citation_pdf_url meta tag', () => {
    const context = contextFor('generic-citation-meta.html', 'https://publisher.example.org/article/1')
    const candidates = genericResolver.discover(context)

    expect(candidates[0]).toMatchObject({
      url: 'https://publisher.example.org/content/10.1000/abcd/fulltext.pdf',
      source: 'citation_pdf_url',
    })
  })

  it('resolves a relative PDF link against the landing page URL', () => {
    const context = contextFor('generic-relative-link.html', 'https://publisher.example.org/article/1')
    const candidates = genericResolver.discover(context)

    expect(candidates.some((c) => c.url === 'https://publisher.example.org/content/pdf/paper.pdf')).toBe(true)
  })

  it('finds a link[type=application/pdf] candidate', () => {
    const context = contextFor('generic-application-pdf-link.html', 'https://publisher.example.org/article/1')
    const candidates = genericResolver.discover(context)

    expect(candidates.some((c) => c.url === 'https://publisher.example.org/paper-fulltext' && c.source.includes('link'))).toBe(true)
  })

  it('deduplicates candidates that resolve to the same URL', () => {
    const context = contextFor('generic-duplicate-candidates.html', 'https://publisher.example.org/article/1')
    const candidates = genericResolver.discover(context)
    const urls = candidates.map((c) => c.url)

    expect(urls.filter((url) => url === 'https://publisher.example.org/fulltext.pdf')).toHaveLength(1)
  })

  it('returns no candidates when the page has no PDF link', () => {
    const context = contextFor('generic-no-candidate.html', 'https://publisher.example.org/article/1')
    expect(genericResolver.discover(context)).toHaveLength(0)
  })

  it('does not accept every link merely containing the letters "pdf"', () => {
    const document = new DOMParser().parseFromString(
      '<html><body><a href="/pdfsomething-unrelated">Read the pdfsomething guide</a></body></html>',
      'text/html',
    )
    const candidates = genericResolver.discover({
      landingUrl: 'https://publisher.example.org/article/1',
      html: '',
      document,
    })
    expect(candidates).toHaveLength(0)
  })
})
