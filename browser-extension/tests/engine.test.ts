import { afterEach, describe, expect, it, vi } from 'vitest'

import { PapertrailClient } from '../src/papertrail/client'
import type { ClaimedJob, JobResult } from '../src/papertrail/types'
import { candidateStartUrl, RetrievalEngine } from '../src/retrieval/engine'
import { installChromeMock } from './chrome-mock'

const connection = {
  serverUrl: 'https://papertrail.example.org',
  agentToken: 'token',
  agentId: 'agent-1',
  displayName: 'Chrome',
  extensionVersion: '0.1.0',
}

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    jobId: 'job-1',
    batchId: 'batch-1',
    projectId: 'project-1',
    publication: {
      id: 'pub-1',
      title: 'Immersive Analytics for Urban Planning',
      doi: null,
      publisherUrl: 'https://publisher.example.org/article/1',
    },
    maxPdfBytes: 50 * 1024 * 1024,
    leaseUntil: new Date(Date.now() + 300_000).toISOString(),
    ...overrides,
  }
}

const PDF_BODY = '%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF'

function jobResultResponse(status: string): Response {
  const body: JobResult = { id: 'job-1', batchId: 'batch-1', status, errorCode: null, errorMessage: null, leaseUntil: null }
  return new Response(JSON.stringify(body), { status: 200 })
}

type FetchMock = { mock: { calls: [RequestInfo | URL, RequestInit?][] } }

function stateCallStatuses(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls
    .filter(([input]) => String(input).endsWith('/state'))
    .map(([, init]) => (JSON.parse(String(init?.body)) as { status: string }).status)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('candidateStartUrl', () => {
  it('prefers a safe publisher URL over the DOI', () => {
    expect(candidateStartUrl(job())).toBe('https://publisher.example.org/article/1')
  })

  it('falls back to the DOI resolver when no publisher URL is present', () => {
    expect(candidateStartUrl(job({ publication: { id: 'pub-1', title: 'x', doi: '10.1000/xyz', publisherUrl: null } })))
      .toBe('https://doi.org/10.1000/xyz')
  })

  it('returns null when neither is available', () => {
    expect(candidateStartUrl(job({ publication: { id: 'pub-1', title: 'x', doi: null, publisherUrl: null } }))).toBeNull()
  })
})

describe('RetrievalEngine.processJob', () => {
  it('claims -> fetches the landing page -> discovers a PDF -> downloads -> validates -> uploads', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/state')) return jobResultResponse((JSON.parse(String(init?.body)) as { status: string }).status)
      if (url.endsWith('/upload')) return jobResultResponse('succeeded')
      if (url === 'https://publisher.example.org/article/1') {
        return new Response(
          '<html><head><meta name="citation_pdf_url" content="https://publisher.example.org/fulltext.pdf"></head><body>abstract</body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === 'https://publisher.example.org/fulltext.pdf') {
        return new Response(PDF_BODY, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const events: string[] = []
    const engine = new RetrievalEngine(client, (event) => events.push(event.phase))

    const outcome = await engine.processJob(job())

    expect(outcome).toEqual({ status: 'succeeded' })
    expect(events).toEqual(expect.arrayContaining([
      'fetching-landing-page', 'discovering-pdf-links', 'downloading-pdf', 'validating-pdf', 'uploading',
    ]))
    const uploadCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/upload'))
    expect(uploadCall).toBeDefined()
  }, 15000)

  it('reports needs_authentication when the landing page asks for institutional sign-in', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/state')) return jobResultResponse((JSON.parse(String(init?.body)) as { status: string }).status)
      if (url === 'https://publisher.example.org/article/1') {
        return new Response('<html><body>Please sign in via your institution to continue</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const engine = new RetrievalEngine(client)
    const outcome = await engine.processJob(job())

    expect(outcome.status).toBe('needs_authentication')
    expect(stateCallStatuses(fetchMock)).toContain('needs_authentication')
  }, 15000)

  it('resolves a DOI through the Handle API and fetches the target directly, not doi.org', async () => {
    // Fetching doi.org and letting the browser follow its redirect hits a
    // real CORS wall in Chrome (host-permission bypass doesn't extend to a
    // redirect target) -- the engine must resolve the DOI first and fetch
    // the publisher URL as a single, non-redirected request instead.
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/state')) return jobResultResponse((JSON.parse(String(init?.body)) as { status: string }).status)
      if (url.endsWith('/upload')) return jobResultResponse('succeeded')
      if (url === 'https://doi.org/api/handles/10.1109%2Fvr.2017.7892377') {
        return new Response(JSON.stringify({
          values: [{ type: 'URL', data: { value: 'http://ieeexplore.ieee.org/document/7892377/' } }],
        }), { status: 200 })
      }
      if (url === 'https://ieeexplore.ieee.org/document/7892377/') {
        return new Response(
          '<html><head><meta name="citation_pdf_url" content="https://ieeexplore.ieee.org/fulltext.pdf"></head></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === 'https://ieeexplore.ieee.org/fulltext.pdf') {
        return new Response(PDF_BODY, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const engine = new RetrievalEngine(client)
    const outcome = await engine.processJob(job({
      publication: { id: 'pub-1', title: 'x', doi: '10.1109/vr.2017.7892377', publisherUrl: null },
    }))

    expect(outcome).toEqual({ status: 'succeeded' })
    const fetchedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(fetchedUrls).not.toContain('https://doi.org/10.1109/vr.2017.7892377')
  })

  it('resolves the DOI instead of fetching a Scopus publisherUrl directly, since Scopus never hosts the PDF', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/state')) return jobResultResponse((JSON.parse(String(init?.body)) as { status: string }).status)
      if (url.endsWith('/upload')) return jobResultResponse('succeeded')
      if (url === 'https://doi.org/api/handles/10.1109%2Fvr.2017.7892377') {
        return new Response(JSON.stringify({
          values: [{ type: 'URL', data: { value: 'https://ieeexplore.ieee.org/document/7892377/' } }],
        }), { status: 200 })
      }
      if (url === 'https://ieeexplore.ieee.org/document/7892377/') {
        return new Response(
          '<html><head><meta name="citation_pdf_url" content="https://ieeexplore.ieee.org/fulltext.pdf"></head></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === 'https://ieeexplore.ieee.org/fulltext.pdf') {
        return new Response(PDF_BODY, { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const engine = new RetrievalEngine(client)
    const outcome = await engine.processJob(job({
      publication: {
        id: 'pub-1',
        title: 'x',
        doi: '10.1109/vr.2017.7892377',
        publisherUrl: 'https://www.scopus.com/record/display.uri?eid=2-s2.0-1',
      },
    }))

    expect(outcome).toEqual({ status: 'succeeded' })
    const fetchedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(fetchedUrls).not.toContain('https://www.scopus.com/record/display.uri?eid=2-s2.0-1')
  })

  it('returns no_permission and makes no publisher request when host permission is missing', async () => {
    installChromeMock({ permissionsContains: async () => false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const engine = new RetrievalEngine(client)
    const outcome = await engine.processJob(job())

    expect(outcome).toEqual({ status: 'no_permission', origin: 'https://*/*' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports invalid_response when the discovered "PDF" is not actually a PDF', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/state')) return jobResultResponse((JSON.parse(String(init?.body)) as { status: string }).status)
      if (url === 'https://publisher.example.org/article/1') {
        return new Response(
          '<html><head><meta name="citation_pdf_url" content="https://publisher.example.org/fulltext.pdf"></head></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        )
      }
      if (url === 'https://publisher.example.org/fulltext.pdf') {
        // Mislabeled as a PDF but the body is not one -- must be caught by
        // validation, not trusted on Content-Type alone.
        return new Response('this is not really a pdf', {
          status: 200,
          headers: { 'Content-Type': 'application/pdf' },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const engine = new RetrievalEngine(client)
    const outcome = await engine.processJob(job())

    expect(outcome.status).toBe('invalid_response')
    expect(stateCallStatuses(fetchMock)).toContain('invalid_response')
  }, 15000)

  it('treats a Papertrail upload conflict (existing PDF) as success without erroring', async () => {
    installChromeMock({ permissionsContains: async () => true })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/state')) return jobResultResponse((JSON.parse(String(init?.body)) as { status: string }).status)
      if (url.endsWith('/upload')) return jobResultResponse('skipped_existing')
      if (url === 'https://publisher.example.org/article/1') {
        return new Response('%PDF-1.4\n%%EOF', { status: 200, headers: { 'Content-Type': 'application/pdf' } })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const engine = new RetrievalEngine(client)
    const outcome = await engine.processJob(job())

    expect(outcome).toEqual({ status: 'succeeded' })
  }, 15000)

  it('reports not_found when the publication has neither a publisher URL nor a DOI', async () => {
    installChromeMock()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/state')) return jobResultResponse((JSON.parse(String(init?.body)) as { status: string }).status)
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const engine = new RetrievalEngine(client)
    const outcome = await engine.processJob(job({ publication: { id: 'pub-1', title: 'x', doi: null, publisherUrl: null } }))

    expect(outcome.status).toBe('not_found')
    expect(stateCallStatuses(fetchMock)).toContain('not_found')
  })
})
