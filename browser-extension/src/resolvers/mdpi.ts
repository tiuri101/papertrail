import { genericResolver } from './generic'
import type { PdfCandidate, PdfResolver, ResolverContext } from './resolver'
import { dedupeCandidates } from './util'

/**
 * MDPI's "Download PDF" link only appears inside a "Download" dropdown menu,
 * and its href (".../pdf", no ".pdf" extension) and surrounding markup don't
 * reliably match the generic resolver's href/text patterns. MDPI article
 * URLs follow a fixed, documented convention instead: appending "/pdf" to
 * the article path always serves the PDF directly, so that's used as a
 * URL-pattern fallback rather than trying to parse the dropdown.
 */
export const mdpiResolver: PdfResolver = {
  name: 'mdpi',
  canHandle: (context) => new URL(context.landingUrl).hostname.endsWith('mdpi.com'),
  discover(context: ResolverContext): PdfCandidate[] {
    const candidates = genericResolver.discover(context)
    const url = new URL(context.landingUrl)
    const articlePath = url.pathname.replace(/\/+$/, '')
    if (articlePath && !/\/pdf$/i.test(articlePath)) {
      const pdfUrl = new URL(`${articlePath}/pdf`, url.origin).toString()
      candidates.push({ url: pdfUrl, confidence: 90, source: 'mdpi-pdf-path' })
    }
    return dedupeCandidates(candidates)
  },
}
