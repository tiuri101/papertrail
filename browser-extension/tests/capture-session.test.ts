import { afterEach, describe, expect, it, vi } from 'vitest'

import { CaptureSession, resolveCapturableUrl } from '../src/capture/capture-session'
import { PapertrailClient } from '../src/papertrail/client'
import { installChromeMock } from './chrome-mock'

const connection = {
  serverUrl: 'https://papertrail.example.org',
  agentToken: 'token',
  agentId: 'agent-1',
  displayName: 'Chrome',
  extensionVersion: '0.1.0',
}

const TAB_URL = 'https://publisher.example.org/paper.pdf'
const PROJECT_ID = 'project-1'
const PROJECT_NAME = 'Systematic Review'
const PDF_BODY = '%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF'

function pdfResponse(): Response {
  return new Response(PDF_BODY, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function session(client: PapertrailClient, tabUrl = TAB_URL, projectId: string | null = PROJECT_ID) {
  return new CaptureSession(client, tabUrl, projectId, PROJECT_NAME, () => {})
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveCapturableUrl', () => {
  it('unwraps a PDF rendered by Chrome\'s built-in PDF Viewer extension', () => {
    expect(resolveCapturableUrl(
      'chrome-extension://efaidnbmnnnibpcajpcglclefindmkaj/https://dl.acm.org/doi/pdf/10.1145/3788851.3815042',
    )).toBe('https://dl.acm.org/doi/pdf/10.1145/3788851.3815042')
  })

  it('leaves an ordinary URL untouched', () => {
    expect(resolveCapturableUrl(TAB_URL)).toBe(TAB_URL)
  })
})

describe('CaptureSession', () => {
  it('reports no_project and fetches nothing when no project was selected in the popup', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client, TAB_URL, null)
    await s.start()

    expect(s.snapshot.phase).toBe('no_project')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('unwraps the Chrome PDF Viewer URL before fetching', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const realUrl = 'https://dl.acm.org/doi/pdf/10.1145/3788851.3815042'
    const wrappedUrl = `chrome-extension://efaidnbmnnnibpcajpcglclefindmkaj/${realUrl}`
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === realUrl) return pdfResponse()
      if (url.includes('/pdf-captures/detect')) {
        return jsonResponse({ detectedDoi: null, detectedTitle: null, ambiguous: false, match: null })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client, wrappedUrl)

    expect(s.snapshot.tabUrl).toBe(realUrl)

    await s.start()

    expect(s.snapshot.phase).toBe('search')
    expect(fetchMock.mock.calls.some(([input]) => String(input) === wrappedUrl)).toBe(false)
  })

  it('stops at permission_needed and fetches nothing without host permission', async () => {
    installChromeMock({ permissionsContains: async () => false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client)
    await s.start()

    expect(s.snapshot.phase).toBe('permission_needed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports not_pdf when the tab is not actually a PDF', async () => {
    installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not a pdf</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })))

    const client = new PapertrailClient(connection)
    const s = session(client)
    await s.start()

    expect(s.snapshot.phase).toBe('not_pdf')
  })

  it('reports a specific hint when the publisher rejects the request (e.g. an expired signed URL)', async () => {
    // Mirrors an expired ScienceDirect/S3 pre-signed PDF URL: Chrome's PDF
    // viewer already rendered the tab from an earlier fetch, but a fresh
    // fetch of the same URL now gets an access-denied response.
    installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<Error><Code>AccessDenied</Code></Error>', {
      status: 403,
      headers: { 'Content-Type': 'application/xml' },
    })))

    const client = new PapertrailClient(connection)
    const s = session(client)
    await s.start()

    expect(s.snapshot.phase).toBe('not_pdf')
    expect(s.snapshot.message).toContain('HTTP 403')
    expect(s.snapshot.message).toMatch(/expire/i)
  })

  it('finds and downloads the PDF from a "Download PDF" link on a landing page', async () => {
    const LANDING_URL = 'https://publisher.example.org/article/1'
    const PDF_URL = 'https://publisher.example.org/fulltext.pdf'
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === LANDING_URL) {
        return new Response(
          '<html><head><meta name="citation_pdf_url" content="https://publisher.example.org/fulltext.pdf"></head><body>abstract</body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === PDF_URL) return pdfResponse()
      if (url.includes('/pdf-captures/detect')) {
        return jsonResponse({ detectedDoi: null, detectedTitle: null, ambiguous: false, match: null })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client, LANDING_URL)
    await s.start()

    expect(s.snapshot.phase).toBe('search')
    expect(fetchMock.mock.calls.some(([input]) => String(input) === PDF_URL)).toBe(true)
  }, 10000)

  it('finds a ScienceDirect "Download PDF" link via the publisher-specific resolver', async () => {
    const LANDING_URL = 'https://www.sciencedirect.com/science/article/pii/S0001'
    const PDF_URL = 'https://pdf.sciencedirectassets.com/main.pdf?X-Amz-Signature=abc'
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === LANDING_URL) {
        return new Response(
          `<html><body><a href="${PDF_URL}">Download PDF</a></body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === PDF_URL) return pdfResponse()
      if (url.includes('/pdf-captures/detect')) {
        return jsonResponse({ detectedDoi: null, detectedTitle: null, ambiguous: false, match: null })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client, LANDING_URL)
    await s.start()

    expect(s.snapshot.phase).toBe('search')
    expect(fetchMock.mock.calls.some(([input]) => String(input) === PDF_URL)).toBe(true)
  }, 10000)

  it('reports needs_authentication when the landing page asks for institutional sign-in', async () => {
    const LANDING_URL = 'https://publisher.example.org/article/1'
    installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>Please sign in via your institution to continue</body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )))

    const client = new PapertrailClient(connection)
    const s = session(client, LANDING_URL)
    await s.start()

    expect(s.snapshot.phase).toBe('not_pdf')
    expect(s.snapshot.message).toMatch(/sign.?in/i)
  })

  it('reports not_pdf when no PDF link is found on the landing page', async () => {
    const LANDING_URL = 'https://publisher.example.org/article/1'
    installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>Just an abstract, no download link here.</body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )))

    const client = new PapertrailClient(connection)
    const s = session(client, LANDING_URL)
    await s.start()

    expect(s.snapshot.phase).toBe('not_pdf')
    expect(s.snapshot.message).toMatch(/no pdf link/i)
  })

  it('auto-attaches when detection finds a single exact DOI match', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url === TAB_URL) return pdfResponse()
      if (url.includes('/pdf-captures/detect')) {
        return jsonResponse({
          detectedDoi: '10.1/x',
          detectedTitle: 'Some Paper',
          ambiguous: false,
          match: { id: 'pub-1', title: 'Some Paper', authors: 'Doe', publicationYear: 2020, doi: '10.1/x' },
        })
      }
      if (url.endsWith('/publications/pub-1/pdf-captures')) {
        return jsonResponse({ documentId: 'doc-1', publicationId: 'pub-1', title: 'Some Paper' })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client)
    await s.start()

    expect(s.snapshot.phase).toBe('success')
    expect(s.snapshot.attachedTitle).toBe('Some Paper')
    const detectCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/pdf-captures/detect'))
    const detectForm = detectCall?.[1]?.body as FormData
    expect(detectForm).toBeInstanceOf(FormData)
    expect(detectForm.get('project_id')).toBe(PROJECT_ID)
    const attachCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/pdf-captures') && !String(input).includes('detect'))
    expect(attachCall).toBeDefined()
  })

  it('falls back to a manual search when no exact DOI match is found', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TAB_URL) return pdfResponse()
      if (url.includes('/pdf-captures/detect')) {
        return jsonResponse({ detectedDoi: null, detectedTitle: null, ambiguous: false, match: null })
      }
      if (url.includes('/publications/search')) {
        return jsonResponse([
          { id: 'pub-1', title: 'Manually Found Paper', authors: 'Doe', publicationYear: 2021, doi: null },
        ])
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client)
    await s.start()

    expect(s.snapshot.phase).toBe('search')
    await s.search('Manually')

    expect(s.snapshot.searchResults).toHaveLength(1)
    expect(s.snapshot.searchResults[0]?.title).toBe('Manually Found Paper')
  })

  it('carries detected metadata into the snapshot for prefilling a create-publication form', async () => {
    installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TAB_URL) return pdfResponse()
      if (url.includes('/pdf-captures/detect')) {
        return jsonResponse({
          detectedDoi: '10.1/x', detectedTitle: 'Detected Title', detectedAuthors: 'Doe, Jane', detectedYear: 2024, ambiguous: false, match: null,
        })
      }
      if (url.includes('/publications/search')) return jsonResponse([])
      throw new Error(`Unexpected fetch: ${url}`)
    }))

    const client = new PapertrailClient(connection)
    const s = session(client)
    await s.start()

    expect(s.snapshot.detectedTitle).toBe('Detected Title')
    expect(s.snapshot.detectedAuthors).toBe('Doe, Jane')
    expect(s.snapshot.detectedYear).toBe(2024)
    expect(s.snapshot.detectedDoi).toBe('10.1/x')
  })

  it('creates a new publication and attaches the capture to it', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TAB_URL) return pdfResponse()
      if (url.includes('/pdf-captures/detect')) {
        return jsonResponse({ detectedDoi: null, detectedTitle: null, detectedAuthors: null, detectedYear: null, ambiguous: false, match: null })
      }
      if (url.includes('/publications/search')) return jsonResponse([])
      if (url.endsWith(`/browser-agent/projects/${PROJECT_ID}/publications`)) {
        const body = JSON.parse(String(init?.body)) as { title: string }
        return jsonResponse({ id: 'pub-new', title: body.title }, 201)
      }
      if (url.endsWith('/publications/pub-new/pdf-captures')) {
        return jsonResponse({ documentId: 'doc-1', publicationId: 'pub-new', title: 'Brand New Paper' })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client)
    await s.start()
    expect(s.snapshot.phase).toBe('search')

    s.showCreatePublicationForm()
    expect(s.snapshot.phase).toBe('create_publication')

    await s.createPublication({ title: 'Brand New Paper' })

    expect(s.snapshot.phase).toBe('success')
    expect(s.snapshot.attachedTitle).toBe('Brand New Paper')
  })

  it('offers a replace confirmation on conflict, then re-attaches with replace=true', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === TAB_URL) return pdfResponse()
      if (url.includes('/pdf-captures/detect')) {
        return jsonResponse({
          detectedDoi: '10.1/x',
          detectedTitle: 'Some Paper',
          ambiguous: false,
          match: { id: 'pub-1', title: 'Some Paper', authors: null, publicationYear: null, doi: '10.1/x' },
        })
      }
      if (url.endsWith('/publications/pub-1/pdf-captures')) {
        const form = init?.body as FormData
        const replace = form.get('replace') === 'true'
        if (!replace) {
          return jsonResponse({ error: { message: 'The publication already has an active PDF' } }, 409)
        }
        return jsonResponse({ documentId: 'doc-2', publicationId: 'pub-1', title: 'Some Paper' })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const s = session(client)
    await s.start()

    expect(s.snapshot.phase).toBe('confirm_replace')

    await s.confirmReplace()

    expect(s.snapshot.phase).toBe('success')
    const attachCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/publications/pub-1/pdf-captures'))
    expect(attachCalls).toHaveLength(2)
  })
})
