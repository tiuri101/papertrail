import { PapertrailAuthError, PapertrailConflictError, type PapertrailClient } from '../papertrail/client'
import type { PublicationPickerResult } from '../papertrail/types'
import {
  hasPublisherAccess,
  PUBLISHER_ACCESS_ORIGIN,
  requestOriginPermission,
} from '../retrieval/permission-manager'
import { filenameFromResponse } from '../retrieval/filename'
import { validatePdfResponse } from '../retrieval/pdf-validator'
import { safeRedirectFetch } from '../retrieval/redirect-fetch'

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

export type CapturePhase =
  | 'starting'
  | 'no_project'
  | 'permission_needed'
  | 'not_pdf'
  | 'working'
  | 'search'
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

  constructor(
    private readonly client: PapertrailClient,
    tabUrl: string,
    private readonly projectId: string | null,
    projectName: string | null,
    private readonly onChange: (snapshot: CaptureSnapshot) => void,
  ) {
    this.state = {
      phase: 'starting',
      message: 'Checking this tab…',
      tabUrl: resolveCapturableUrl(tabUrl),
      projectName,
      searchQuery: '',
      searchResults: [],
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
    this.set({ phase: 'working', message: 'Downloading the PDF from this tab…' })
    let result: Awaited<ReturnType<typeof safeRedirectFetch>>
    try {
      result = await safeRedirectFetch(this.state.tabUrl)
    } catch {
      this.set({
        phase: 'not_pdf',
        message: 'Could not load the current tab as a PDF. Make sure a PDF is open in it.',
      })
      return
    }
    const validation = await validatePdfResponse(result.response, MAX_CAPTURE_BYTES)
    if (!validation.valid) {
      this.set({
        phase: 'not_pdf',
        message: `The current tab doesn't look like a PDF (${validation.reason}).`,
      })
      return
    }
    this.pdfBlob = validation.blob
    this.pdfFilename = filenameFromResponse(result.response, result.finalUrl, '')
    await this.detectAndAttach()
  }

  private async detectAndAttach(): Promise<void> {
    this.set({ phase: 'working', message: 'Checking for a matching publication…' })
    if (!this.pdfBlob || !this.projectId) return
    try {
      const detected = await this.client.detectPdfMatch(this.projectId, this.pdfBlob, this.pdfFilename)
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
