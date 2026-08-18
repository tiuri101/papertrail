import { genericResolver } from './generic'
import type { PdfCandidate, PdfResolver, ResolverContext } from './resolver'
import { dedupeCandidates } from './util'

const ARNUMBER_QUERY_PATTERN = /[?&]arnumber=(\d+)/
const DOCUMENT_PATH_PATTERN = /\/document\/(\d+)/
const ISNUMBER_QUERY_PATTERN = /[?&]isnumber=(\d+)/

/**
 * IEEE Xplore is heavily JavaScript-rendered, so this stays intentionally
 * light: it prefers the standard citation_pdf_url metadata (present on
 * IEEE's server-rendered article pages) via the generic resolver, and only
 * adds a documented URL-pattern fallback derived from the article number
 * already present in the landing URL -- no undocumented private APIs.
 *
 * `/stamp/stamp.jsp` -- an older, widely-copied fallback -- now only ever
 * returns IEEE's HTML viewer shell rather than PDF bytes, so a plain fetch
 * of it can never pass PDF validation and every job using it fails as
 * `invalid_response`. `/stampPDF/getPDF.jsp` is the documented
 * direct-download counterpart that still streams the raw PDF for an
 * authenticated/entitled session; `isnumber` is included when present in
 * the landing URL but is not required.
 */
export const ieeeResolver: PdfResolver = {
  name: 'ieee',
  canHandle: (context) => new URL(context.landingUrl).hostname.endsWith('ieeexplore.ieee.org'),
  discover(context: ResolverContext): PdfCandidate[] {
    const candidates = genericResolver.discover(context)
    const arnumber = ARNUMBER_QUERY_PATTERN.exec(context.landingUrl)?.[1]
      ?? DOCUMENT_PATH_PATTERN.exec(context.landingUrl)?.[1]
    if (arnumber) {
      const isnumber = ISNUMBER_QUERY_PATTERN.exec(context.landingUrl)?.[1] ?? ''
      const pdfUrl = new URL(
        `/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}&isnumber=${isnumber}`,
        context.landingUrl,
      ).toString()
      candidates.push({ url: pdfUrl, confidence: 50, source: 'ieee-getpdf-fallback' })
    }
    return dedupeCandidates(candidates)
  },
}
