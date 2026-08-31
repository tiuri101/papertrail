import { PapertrailAuthError, PapertrailConflictError, type PapertrailClient } from '../papertrail/client'
import type { NewPublicationFields, PublicationPickerResult } from '../papertrail/types'
import { resolverFor } from '../resolvers'
import { tryPdfCandidates } from '../retrieval/candidate-fetch'
import { filenameFromResponse } from '../retrieval/filename'
import {
  hasPublisherAccess,
  PUBLISHER_ACCESS_ORIGIN,
  requestOriginPermission,
} from '../retrieval/permission-manager'
import { validatePdfBytes, validatePdfResponse } from '../retrieval/pdf-validator'
import { safeRedirectFetch } from '../retrieval/redirect-fetch'
import { MAX_LANDING_PAGE_BYTES, readTextWithLimit } from '../retrieval/response-limits'
import { looksLikeLoginOrPaywallPage } from '../retrieval/response-classifier'
import { captureCandidatePdfFromTab } from './tab-pdf-probe'

// A generous client-side cap on the streamed download -- only an early
// rejection so a clearly-wrong response isn't read forever, mirroring the
// comment on validatePdfResponse: the server independently enforces its own
// configured max_pdf_size_mb limit and is the authority.
const MAX_CAPTURE_BYTES = 200 * 1024 * 1024

// Chrome's built-in PDF Viewer component extension. When it renders a PDF,
// chrome.tabs.query reports the tab's url as this extension's own URL with
// the real address appended as a path -- not the PDF's address directly --
// so a tab showing e.g. https://dl.acm.org/doi/pdf/10.1145/x reports
// "chrome-extension://efaidnbmnnnibpcajpcglclefindmkaj/https://dl.acm.org/doi/pdf/10.1145/x".
// Unwrap that before treating the value as a fetchable URL.
const CHROME_PDF_VIEWER_URL_PREFIX = 'chrome-extension://efaidnbmnnnibpcajpcglclefindmkaj/'

export function resolveCapturableUrl(tabUrl: string): string {
  return tabUrl.startsWith(CHROME_PDF_VIEWER_URL_PREFIX)
    ? tabUrl.slice(CHROME_PDF_VIEWER_URL_PREFIX.length)
    : tabUrl
}

// Several publishers (ScienceDirect/Elsevier notably) serve the PDF itself
// from a short-lived, pre-signed CDN URL -- often valid for only a few
// minutes. Chrome's PDF viewer only fetches it once to render the tab and
// keeps showing those bytes indefinitely afterwards, so a tab can look
// perfectly normal long after the link behind it has expired. A re-fetch of
// that same URL then gets rejected by the CDN even though nothing is wrong
// with the tab the user is looking at.
const EXPIRED_LINK_HINT = 'Some publishers\' PDF links expire within minutes of the page '
  + 'loading, even though the tab keeps displaying it -- try reloading the tab and capturing '
  + 'again right away.'

export type CapturePhase =
  | 'starting'
  | 'no_project'
  | 'permission_needed'
  | 'not_pdf'
  | 'working'
  | 'search'
  | 'create_publication'
  | 'confirm_replace'
  | 'success'
  | 'error'

export interface CaptureSnapshot {
  phase: CapturePhase
  message: string
  tabUrl: string
  projectName: string | null
  searchQuery: string
  searchResults: PublicationPickerResult[]
  detectedTitle: string | null
  detectedAuthors: string | null
  detectedYear: number | null
  detectedDoi: string | null
  pendingPublicationId: string | null
  pendingPublicationTitle: string | null
  attachedTitle: string | null
  authError: string | null
}

/**
 * Drives a single ad-hoc capture: the PDF open in the tab the user invoked
 * this from, attached to a publication they either get matched to
 * automatically (an exact DOI match) or pick by hand, within the project the
 * popup's own project selector already chose -- this page is never the place
 * that choice is made, so there is no per-capture "which project?" step or
 * page to navigate here for it.
 */
export class CaptureSession {
  private state: CaptureSnapshot
  private pdfBlob: Blob | null = null
  private pdfFilename = 'paper.pdf'
  private triedTabScriptCapture = false

  constructor(
    private readonly client: PapertrailClient,
    tabUrl: string,
    private readonly projectId: string | null,
    projectName: string | null,
    private readonly onChange: (snapshot: CaptureSnapshot) => void,
    private readonly tabId: number | null = null,
  ) {
    this.state = {
      phase: 'starting',
      message: 'Checking this tab…',
      tabUrl: resolveCapturableUrl(tabUrl),
      projectName,
      searchQuery: '',
      searchResults: [],
      detectedTitle: null,
      detectedAuthors: null,
      detectedYear: null,
      detectedDoi: null,
      pendingPublicationId: null,
      pendingPublicationTitle: null,
      attachedTitle: null,
      authError: null,
    }
  }

  get snapshot(): CaptureSnapshot {
    return { ...this.state }
  }

  private set(patch: Partial<CaptureSnapshot>): void {
    this.state = { ...this.state, ...patch }
    this.onChange(this.snapshot)
  }

  async start(): Promise<void> {
    if (!this.state.tabUrl) {
      this.set({ phase: 'not_pdf', message: 'Could not determine the URL of the current tab.' })
      return
    }
    if (!this.projectId) {
      this.set({
        phase: 'no_project',
        message: 'No project is selected. Pick one from the extension popup, then try again.',
      })
      return
    }
    if (!(await hasPublisherAccess())) {
      this.set({
        phase: 'permission_needed',
        message: 'Papertrail needs permission to read this page to capture its PDF.',
      })
      return
    }
    await this.fetchAndValidate()
  }

  async grantPermissionAndContinue(): Promise<void> {
    const granted = await requestOriginPermission(PUBLISHER_ACCESS_ORIGIN)
    if (!granted) {
      this.set({ message: 'Permission was not granted.' })
      return
    }
    await this.fetchAndValidate()
  }

  private async fetchAndValidate(): Promise<void> {
    this.set({ phase: 'working', message: 'Loading this page…' })
    let landing: Awaited<ReturnType<typeof safeRedirectFetch>>
    try {
      landing = await safeRedirectFetch(this.state.tabUrl)
    } catch {
      await this.failNotPdf('Could not load the current tab. Make sure a PDF or publication page is open in it.')
      return
    }
    if (!landing.response.ok) {
      await this.failNotPdf(`The publisher rejected this request (HTTP ${landing.response.status}). ${EXPIRED_LINK_HINT}`)
      return
    }

    let pdfResponse = landing.response
    let pdfFinalUrl = landing.finalUrl
    const contentType = landing.response.headers.get('Content-Type') ?? ''

    // The tab may already be the PDF itself (Chrome's built-in viewer), or
    // it may be a publication's landing/abstract page with a "Download PDF"
    // button -- in which case the same resolver-based discovery the
    // job-driven retrieval flow uses finds that link on the page.
    if (!contentType.includes('application/pdf')) {
      const discovered = await this.discoverPdfFromLandingPage(landing.response, landing.finalUrl)
      if (!discovered) return
      pdfResponse = discovered.response
      pdfFinalUrl = discovered.finalUrl
    }

    const validation = await validatePdfResponse(pdfResponse, MAX_CAPTURE_BYTES)
    if (!validation.valid) {
      await this.failNotPdf(`The current tab doesn't look like a PDF (${validation.reason}). ${EXPIRED_LINK_HINT}`)
      return
    }
    this.pdfBlob = validation.blob
    this.pdfFilename = filenameFromResponse(pdfResponse, pdfFinalUrl, '')
    await this.detectAndAttach()
  }

  /** Reports a terminal "couldn't find/fetch a PDF" outcome -- but first, if
   * we haven't already, tries reading the PDF directly out of the live tab
   * (see tab-pdf-probe.ts) rather than the background fetch that just
   * failed. Some publishers block the background fetch's request
   * fingerprint outright, cookies or not, but don't block a fetch issued
   * from inside the tab the user already has open. */
  private async failNotPdf(message: string): Promise<void> {
    if (!this.triedTabScriptCapture) {
      this.triedTabScriptCapture = true
      const captured = await this.tryTabScriptCapture()
      if (captured) {
        this.pdfBlob = captured.blob
        this.pdfFilename = captured.filename
        await this.detectAndAttach()
        return
      }
    }
    this.set({ phase: 'not_pdf', message })
  }

  private async tryTabScriptCapture(): Promise<{ blob: Blob; filename: string } | null> {
    if (this.tabId === null) return null
    if (typeof chrome === 'undefined' || !chrome.scripting?.executeScript) return null

    this.set({ message: 'Trying to read the PDF link directly from the open tab…' })
    let results: chrome.scripting.InjectionResult<Awaited<ReturnType<typeof captureCandidatePdfFromTab>>>[]
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: this.tabId },
        func: captureCandidatePdfFromTab,
        args: [this.state.tabUrl, MAX_CAPTURE_BYTES],
      })
    } catch {
      return null
    }

    const outcome = results[0]?.result
    if (!outcome?.ok) return null

    let bytes: Uint8Array<ArrayBuffer>
    try {
      const binary = atob(outcome.base64)
      bytes = new Uint8Array(binary.length) as Uint8Array<ArrayBuffer>
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    } catch {
      return null
    }

    const validation = await validatePdfBytes(bytes, outcome.contentType, MAX_CAPTURE_BYTES)
    if (!validation.valid) return null
    return { blob: validation.blob, filename: filenameFromResponse(new Response(null), outcome.finalUrl, '') }
  }

  /** Looks for a "Download PDF"-style link on a publication's landing page
   * and fetches it, using the same publisher-specific resolvers
   * (src/resolvers/) the job-driven retrieval flow discovers PDFs with.
   * Returns null (having already set a terminal not_pdf snapshot) when no
   * PDF could be found this way. */
  private async discoverPdfFromLandingPage(
    response: Response,
    landingUrl: string,
  ): Promise<{ response: Response; finalUrl: string } | null> {
    this.set({ message: 'Looking for a PDF link on this page…' })
    let html: string
    try {
      html = await readTextWithLimit(response, MAX_LANDING_PAGE_BYTES)
    } catch (error) {
      await this.failNotPdf(`Could not read this page (${error instanceof Error ? error.message : 'unknown error'}).`)
      return null
    }
    if (looksLikeLoginOrPaywallPage(html)) {
      await this.failNotPdf('This page asked for institutional sign-in, so no PDF could be found.')
      return null
    }

    const document = new DOMParser().parseFromString(html, 'text/html')
    const resolver = resolverFor({ landingUrl, html, document })
    const candidates = resolver.discover({ landingUrl, html, document })
    if (candidates.length === 0) {
      await this.failNotPdf('No PDF link (e.g. a "Download PDF" button) was found on this page.')
      return null
    }

    this.set({ message: 'Downloading the PDF…' })
    const outcome = await tryPdfCandidates(candidates)
    if (outcome.status === 'needs_authentication') {
      await this.failNotPdf('The PDF link on this page required institutional sign-in.')
      return null
    }
    if (outcome.status === 'not_found') {
      await this.failNotPdf(`No accessible PDF link was found on this page. ${EXPIRED_LINK_HINT}`)
      return null
    }
    return { response: outcome.response, finalUrl: outcome.finalUrl }
  }

  private async detectAndAttach(): Promise<void> {
    this.set({ phase: 'working', message: 'Checking for a matching publication…' })
    if (!this.pdfBlob || !this.projectId) return
    try {
      const detected = await this.client.detectPdfMatch(this.projectId, this.pdfBlob, this.pdfFilename)
      this.set({
        detectedTitle: detected.detectedTitle,
        detectedAuthors: detected.detectedAuthors,
        detectedYear: detected.detectedYear,
        detectedDoi: detected.detectedDoi,
      })
      if (detected.match) {
        await this.attach(detected.match.id, detected.match.title, false)
        return
      }
      await this.search(detected.detectedTitle ?? '')
    } catch (error) {
      this.handleClientError(error)
    }
  }

  async search(query: string): Promise<void> {
    if (!this.projectId) return
    this.set({ phase: 'search', searchQuery: query })
    const trimmed = query.trim()
    if (!trimmed) {
      this.set({ searchResults: [] })
      return
    }
    try {
      const results = await this.client.searchPublications(this.projectId, trimmed)
      // A slower search that resolves after a newer one was already
      // started would otherwise clobber its results with stale ones.
      if (this.state.searchQuery !== query) return
      this.set({ searchResults: results })
    } catch (error) {
      this.handleClientError(error)
    }
  }

  /** Switches to the create-publication form, prefilled with whatever was
   * detected from the PDF itself -- the reviewer only needs to fill in
   * what's missing or wrong, not start from a blank form. */
  showCreatePublicationForm(): void {
    this.set({ phase: 'create_publication' })
  }

  async createPublication(fields: NewPublicationFields): Promise<void> {
    if (!this.projectId) return
    this.set({ phase: 'working', message: `Creating "${fields.title}"…` })
    try {
      const created = await this.client.createPublication(this.projectId, fields)
      await this.attach(created.id, created.title, false)
    } catch (error) {
      this.handleClientError(error)
    }
  }

  async attach(publicationId: string, title: string, replace: boolean): Promise<void> {
    this.set({ phase: 'working', message: `Attaching to "${title}"…` })
    if (!this.pdfBlob) return
    try {
      const result = await this.client.uploadCapturedPdf(
        publicationId,
        this.pdfBlob,
        this.pdfFilename,
        replace,
      )
      this.set({
        phase: 'success',
        attachedTitle: result.title,
        message: `Attached the PDF to "${result.title}".`,
      })
    } catch (error) {
      if (error instanceof PapertrailConflictError) {
        this.set({
          phase: 'confirm_replace',
          pendingPublicationId: publicationId,
          pendingPublicationTitle: title,
          message: error.message,
        })
        return
      }
      this.handleClientError(error)
    }
  }

  async confirmReplace(): Promise<void> {
    const { pendingPublicationId, pendingPublicationTitle } = this.state
    if (!pendingPublicationId || !pendingPublicationTitle) return
    await this.attach(pendingPublicationId, pendingPublicationTitle, true)
  }

  /** Back out of a replace confirmation to keep looking, rather than only
   * being able to accept or abandon the capture entirely. */
  backToSearch(): void {
    this.set({
      phase: 'search',
      pendingPublicationId: null,
      pendingPublicationTitle: null,
      message: 'Search for the publication.',
    })
  }

  private handleClientError(error: unknown): void {
    if (error instanceof PapertrailAuthError) {
      this.set({ phase: 'error', authError: error.message, message: error.message })
      return
    }
    this.set({
      phase: 'error',
      message: error instanceof Error ? error.message : 'Something went wrong.',
    })
  }
}
