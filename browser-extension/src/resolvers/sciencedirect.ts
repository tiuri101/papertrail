import { genericResolver } from './generic'
import type { PdfCandidate, PdfResolver, ResolverContext } from './resolver'
import { dedupeCandidates, resolveHref } from './util'

export const scienceDirectResolver: PdfResolver = {
  name: 'sciencedirect',
  canHandle: (context) => new URL(context.landingUrl).hostname.endsWith('sciencedirect.com'),
  discover(context: ResolverContext): PdfCandidate[] {
    const candidates = genericResolver.discover(context)
    context.document.querySelectorAll('a[href*="pdfft"]').forEach((anchor) => {
      const resolved = resolveHref(anchor.getAttribute('href'), context.landingUrl)
      if (resolved) candidates.push({ url: resolved, confidence: 85, source: 'sciencedirect-pdfft-link' })
    })
    return dedupeCandidates(candidates)
  },
}
