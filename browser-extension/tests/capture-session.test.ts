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
