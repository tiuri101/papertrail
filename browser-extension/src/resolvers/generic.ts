import type { PdfCandidate, PdfResolver, ResolverContext } from './resolver'
import { dedupeCandidates, resolveHref } from './util'

const DOWNLOAD_TEXT_PATTERN = /download pdf|view pdf|full text pdf|pdf full text|get pdf/i
const PDF_HREF_PATTERN = /\.pdf(\?|#|$)/i

/**
 * Parses already-fetched HTML for standard/common PDF link patterns without
 * executing any publisher script. Used as-is by most publishers, and as a
 * baseline that publisher-specific resolvers extend.
 */
export const genericResolver: PdfResolver = {
  name: 'generic',
  canHandle: () => true,
  discover(context: ResolverContext): PdfCandidate[] {
    const candidates: PdfCandidate[] = []
    const { document, landingUrl } = context

    const citationMeta = document.querySelector('meta[name="citation_pdf_url"]')
    const citationUrl = resolveHref(citationMeta?.getAttribute('content'), landingUrl)
    if (citationUrl) candidates.push({ url: citationUrl, confidence: 100, source: 'citation_pdf_url' })

    document.querySelectorAll('link[type="application/pdf"]').forEach((link) => {
      const resolved = resolveHref(link.getAttribute('href'), landingUrl)
      if (resolved) candidates.push({ url: resolved, confidence: 80, source: 'link[type=application/pdf]' })
    })

    document.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href') ?? ''
      const text = (anchor.textContent ?? '').trim()
      if (PDF_HREF_PATTERN.test(href)) {
        const resolved = resolveHref(href, landingUrl)
        if (resolved) candidates.push({ url: resolved, confidence: 60, source: 'a[href$=.pdf]' })
      } else if (DOWNLOAD_TEXT_PATTERN.test(text)) {
        const resolved = resolveHref(href, landingUrl)
        if (resolved) candidates.push({ url: resolved, confidence: 40, source: 'a[text~=pdf]' })
      }
    })

    return dedupeCandidates(candidates)
  },
}
