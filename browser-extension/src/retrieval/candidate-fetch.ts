import type { PdfCandidate } from '../resolvers/resolver'
import { hasOriginPermission, originPattern } from './permission-manager'
import { safeRedirectFetch } from './redirect-fetch'
import { MAX_LANDING_PAGE_BYTES, readTextWithLimit } from './response-limits'
import { looksLikeLoginOrPaywallPage } from './response-classifier'
import { isSafePublisherUrl } from './url-safety'

export type CandidateFetchOutcome =
  | { status: 'found'; response: Response; finalUrl: string }
  | { status: 'needs_authentication'; finalUrl: string }
  | { status: 'not_found' }

/** A short, polite pause before each candidate request, so discovering and
 * downloading a PDF doesn't read as a rapid-fire scrape of the publisher. */
export const CANDIDATE_REQUEST_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Tries each discovered PDF candidate URL in order, skipping ones outside
 * granted permission, unsafe, or that turn out to be another HTML page,
 * until one yields an actual (still unvalidated) response. Shared between
 * the job-driven RetrievalEngine and the manual-capture flow so a fix or
 * policy change here (the request pacing, what counts as a paywall page,
 * etc.) applies to both instead of drifting apart.
 */
export async function tryPdfCandidates(
  candidates: PdfCandidate[],
  options: { delayMs?: number } = {},
): Promise<CandidateFetchOutcome> {
  const delayMs = options.delayMs ?? CANDIDATE_REQUEST_DELAY_MS
  for (const candidate of candidates) {
    if (!isSafePublisherUrl(candidate.url)) continue
    const origin = originPattern(candidate.url)
    if (!(await hasOriginPermission(origin))) {
      // A candidate might live on a different origin than the landing page
      // (e.g. a CDN). Skip rather than silently requesting broader access
      // than the user granted.
      continue
    }

    await sleep(delayMs)

    let candidateResult
    try {
      candidateResult = await safeRedirectFetch(candidate.url)
    } catch {
      continue
    }
    if (!candidateResult.response.ok) continue

    const candidateContentType = candidateResult.response.headers.get('Content-Type') ?? ''
    if (candidateContentType.includes('text/html')) {
      let body: string
      try {
        body = await readTextWithLimit(candidateResult.response, MAX_LANDING_PAGE_BYTES)
      } catch {
        // An oversized or stalled HTML body tells us nothing useful about
        // this candidate -- move on to the next one.
        continue
      }
      if (looksLikeLoginOrPaywallPage(body)) {
        return { status: 'needs_authentication', finalUrl: candidateResult.finalUrl }
      }
      continue
    }

    return { status: 'found', response: candidateResult.response, finalUrl: candidateResult.finalUrl }
  }

  return { status: 'not_found' }
}
