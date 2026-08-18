import { genericResolver } from './generic'
import type { PdfCandidate, PdfResolver, ResolverContext } from './resolver'
import { dedupeCandidates, resolveHref } from './util'

export const springerResolver: PdfResolver = {
  name: 'springer',
  canHandle: (context) => new URL(context.landingUrl).hostname.endsWith('link.springer.com'),
  discover(context: ResolverContext): PdfCandidate[] {
    const candidates = genericResolver.discover(context)
    context.document
      .querySelectorAll('a[href*="/content/pdf/"], a[data-track-action="download pdf"]')
      .forEach((anchor) => {
        const resolved = resolveHref(anchor.getAttribute('href'), context.landingUrl)
        if (resolved) candidates.push({ url: resolved, confidence: 85, source: 'springer-pdf-link' })
      })
    return dedupeCandidates(candidates)
  },
}
