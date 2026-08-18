import type { PapertrailClient } from '../papertrail/client'
import type { ClaimedJob, TerminalFailureStatus } from '../papertrail/types'
import { resolverFor } from '../resolvers'
import type { PdfCandidate } from '../resolvers/resolver'
import { resolveDoiUrl } from './doi-resolver'
import { filenameFromResponse } from './filename'
import { hasOriginPermission, hasPublisherAccess, originPattern, PUBLISHER_ACCESS_ORIGIN } from './permission-manager'
import { validatePdfResponse } from './pdf-validator'
import { safeRedirectFetch } from './redirect-fetch'
import { looksLikeLoginOrPaywallPage } from './response-classifier'
import { isSafePublisherUrl } from './url-safety'

export type EngineJobOutcome =
  | { status: 'succeeded' }
  | { status: 'no_permission'; origin: string }
  | { status: TerminalFailureStatus; message: string }

export type EnginePhase =
  | 'resolving-start-url'
  | 'fetching-landing-page'
  | 'discovering-pdf-links'
  | 'downloading-pdf'
  | 'validating-pdf'
  | 'uploading'

export interface EngineEvent {
  phase: EnginePhase
  job: ClaimedJob
}

const REQUEST_DELAY_MS = 1000
const ERROR_MESSAGE_MAX_LENGTH = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Deterministic candidate start URL: prefer the publisher URL Papertrail
 * supplied, otherwise fall back to the DOI resolver. Never anything else --
 * this extension does not perform web searches. */
export function candidateStartUrl(job: ClaimedJob): string | null {
  const { publisherUrl, doi } = job.publication
  if (publisherUrl && isSafePublisherUrl(publisherUrl)) return publisherUrl
  if (doi) return `https://doi.org/${encodeURI(doi)}`
  return null
}

export class RetrievalEngine {
  constructor(
    private readonly client: PapertrailClient,
    private readonly onEvent: (event: EngineEvent) => void = () => {},
  ) {}

  async processJob(job: ClaimedJob): Promise<EngineJobOutcome> {
    const fallbackStartUrl = candidateStartUrl(job)
    if (!fallbackStartUrl) {
      return this.reportTerminal(job, 'not_found', 'No publisher URL or DOI is available for this publication')
    }

    // A single broad grant, not a per-origin one: DOI resolution routinely
    // redirects to a publisher origin that's opaque to this code until the
    // browser has already followed it (see redirect-fetch.ts), so there's
    // no specific origin to request permission for in advance.
    if (!(await hasPublisherAccess())) {
      return { status: 'no_permission', origin: PUBLISHER_ACCESS_ORIGIN }
    }

    // A Chrome extension's CORS bypass only applies to the exact URL passed
    // to fetch() -- not wherever its redirect chain ends up (confirmed
    // against a real DOI -> IEEE Xplore redirect: even with full publisher
    // access granted, the browser still blocks the redirected-to origin by
    // CORS policy). So when there's no direct publisher URL, resolve the
    // DOI to its real target via the Handle API first and fetch that
    // directly, rather than fetching doi.org and relying on it to redirect.
    const { publisherUrl, doi } = job.publication
    const startUrl = (!publisherUrl || !isSafePublisherUrl(publisherUrl)) && doi
      ? (await resolveDoiUrl(doi)) ?? fallbackStartUrl
      : fallbackStartUrl

    this.onEvent({ phase: 'fetching-landing-page', job })
    await this.client.updateJobState(job.jobId, { status: 'retrieving' })

    console.debug('[papertrail] job', job.jobId, 'starting from', startUrl)
    let landing
    try {
      landing = await safeRedirectFetch(startUrl)
    } catch (error) {
      console.debug('[papertrail] job', job.jobId, 'landing-page fetch threw', error)
      return this.reportTerminal(job, 'failed', messageOf(error))
    }

    const { response, finalUrl } = landing
    console.debug('[papertrail] job', job.jobId, 'landed on', finalUrl, 'status', response.status)
    const byStatus = this.classifyByHttpStatus(response.status)
    if (byStatus) {
      return this.reportTerminal(job, byStatus.status, byStatus.message, finalUrl, response.status)
    }

    const contentType = response.headers.get('Content-Type') ?? ''
    await sleep(REQUEST_DELAY_MS)

    if (contentType.includes('application/pdf')) {
      return this.downloadAndUpload(job, response, finalUrl, finalUrl)
    }

    this.onEvent({ phase: 'discovering-pdf-links', job })
    const html = await response.text()
    if (looksLikeLoginOrPaywallPage(html)) {
      return this.reportTerminal(
        job,
        'needs_authentication',
        'The publisher page asked for institutional sign-in',
        finalUrl,
      )
    }

    const document = new DOMParser().parseFromString(html, 'text/html')
    const resolver = resolverFor({ landingUrl: finalUrl, html, document })
    const candidates = resolver.discover({ landingUrl: finalUrl, html, document })
    console.debug(
      '[papertrail] job', job.jobId, 'resolver', resolver.name,
      'html length', html.length, 'candidates', candidates.map((c) => c.url),
    )
    if (candidates.length === 0) {
      return this.reportTerminal(job, 'not_found', 'No PDF link was found on the publisher page', finalUrl)
    }

    return this.tryCandidates(job, candidates, finalUrl)
  }

  private async tryCandidates(
    job: ClaimedJob,
    candidates: PdfCandidate[],
    landingUrl: string,
  ): Promise<EngineJobOutcome> {
    for (const candidate of candidates) {
      if (!isSafePublisherUrl(candidate.url)) continue
      const origin = originPattern(candidate.url)
      if (!(await hasOriginPermission(origin))) {
        // A candidate might live on a different origin than the landing
        // page (e.g. a CDN). Skip rather than silently requesting broader
        // access than the user granted.
        continue
      }

      this.onEvent({ phase: 'downloading-pdf', job })
      await sleep(REQUEST_DELAY_MS)

      let candidateResult
      try {
        candidateResult = await safeRedirectFetch(candidate.url)
      } catch {
        continue
      }
      if (!candidateResult.response.ok) continue

      const candidateContentType = candidateResult.response.headers.get('Content-Type') ?? ''
      if (candidateContentType.includes('text/html')) {
        const body = await candidateResult.response.text()
        if (looksLikeLoginOrPaywallPage(body)) {
          return this.reportTerminal(
            job,
            'needs_authentication',
            'The PDF link required institutional sign-in',
            candidateResult.finalUrl,
          )
        }
        continue
      }

      return this.downloadAndUpload(job, candidateResult.response, candidateResult.finalUrl, landingUrl)
    }

    return this.reportTerminal(
      job,
      'not_found',
      'No accessible PDF link was found on the publisher page',
      landingUrl,
    )
  }

  private async downloadAndUpload(
    job: ClaimedJob,
    response: Response,
    sourceUrl: string,
    landingUrl: string,
  ): Promise<EngineJobOutcome> {
    this.onEvent({ phase: 'validating-pdf', job })
    const validation = await validatePdfResponse(response, job.maxPdfBytes)
    if (!validation.valid) {
      return this.reportTerminal(job, 'invalid_response', validation.reason, landingUrl)
    }

    this.onEvent({ phase: 'uploading', job })
    await this.client.updateJobState(job.jobId, {
      status: 'uploading',
      resolvedPdfUrl: sourceUrl,
      resolvedLandingUrl: landingUrl,
    })

    const filename = filenameFromResponse(response, sourceUrl, job.publication.title)
    try {
      const result = await this.client.uploadPdf(job.jobId, validation.blob, filename, sourceUrl, landingUrl)
      if (result.status === 'succeeded' || result.status === 'skipped_existing') {
        return { status: 'succeeded' }
      }
      return { status: 'failed', message: result.errorMessage ?? 'Upload did not complete' }
    } catch (error) {
      return this.reportTerminal(job, 'failed', messageOf(error))
    }
  }

  private classifyByHttpStatus(
    status: number,
  ): { status: TerminalFailureStatus; message: string } | null {
    if (status === 401 || status === 403) {
      return { status: 'access_denied', message: `Publisher returned HTTP ${status}` }
    }
    if (status === 404) {
      return { status: 'not_found', message: 'Publisher returned HTTP 404' }
    }
    if (status === 429) {
      return { status: 'failed', message: 'Publisher is rate limiting requests (HTTP 429)' }
    }
    if (status >= 500) {
      return { status: 'failed', message: `Publisher returned HTTP ${status}` }
    }
    return null
  }

  private async reportTerminal(
    job: ClaimedJob,
    status: TerminalFailureStatus,
    message: string,
    landingUrl?: string,
    httpStatus?: number,
  ): Promise<EngineJobOutcome> {
    const truncated = message.slice(0, ERROR_MESSAGE_MAX_LENGTH)
    try {
      await this.client.updateJobState(job.jobId, {
        status,
        errorMessage: truncated,
        resolvedLandingUrl: landingUrl,
        httpStatus,
      })
    } catch {
      // Reporting failure is best-effort -- the job's lease will simply
      // expire and become reclaimable if this can't reach Papertrail.
    }
    return { status, message: truncated }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
