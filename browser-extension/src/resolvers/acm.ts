import { genericResolver } from './generic'
import type { PdfCandidate, PdfResolver, ResolverContext } from './resolver'
import { dedupeCandidates } from './util'

const DOI_PATH_PATTERN = /\/doi\/(?:abs\/|full\/)?(10\.\d{4,9}\/[^/?#]+)/

export const acmResolver: PdfResolver = {
  name: 'acm',
  canHandle: (context) => new URL(context.landingUrl).hostname.endsWith('dl.acm.org'),
  discover(context: ResolverContext): PdfCandidate[] {
    const candidates = genericResolver.discover(context)
    const doiMatch = DOI_PATH_PATTERN.exec(context.landingUrl)
    if (doiMatch?.[1]) {
      const pdfUrl = new URL(`/doi/pdf/${doiMatch[1]}`, context.landingUrl).toString()
      candidates.push({ url: pdfUrl, confidence: 90, source: 'acm-doi-pdf-path' })
    }
    return dedupeCandidates(candidates)
  },
}
