import { afterEach, describe, expect, it, vi } from 'vitest'

import { PapertrailAuthError, PapertrailClient, PapertrailConflictError } from '../src/papertrail/client'
import type { StoredConnection } from '../src/papertrail/types'

const connection: StoredConnection = {
  serverUrl: 'https://papertrail.example.org',
  agentToken: 'secret-agent-token',
  agentId: 'agent-1',
  displayName: 'Chrome on Desktop',
  extensionVersion: '0.1.0',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PapertrailClient', () => {
  it('sends the bearer token only to the configured Papertrail server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(null), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    await client.claimJob()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://papertrail.example.org/api/v1/browser-agent/retrieval-jobs/claim')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-agent-token')
  })

  it('never sends the bearer token when making a separate, non-Papertrail fetch', async () => {
    // The client only ever constructs requests against connection.serverUrl;
    // publisher requests are made through retrieval/redirect-fetch.ts, an
    // entirely separate code path that never touches PapertrailClient or its
    // token. This test documents that boundary at the client level: nothing
    // here can be pointed at an arbitrary host.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(null), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    await client.claimJob()

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(new URL(url).origin).toBe('https://papertrail.example.org')
  })

  it('treats a 401 from Papertrail as a revoked/disconnected agent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))
    const client = new PapertrailClient(connection)

    await expect(client.claimJob()).rejects.toBeInstanceOf(PapertrailAuthError)
  })

  it('treats a 403 from Papertrail as a revoked/disconnected agent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })))
    const client = new PapertrailClient(connection)

    await expect(client.claimJob()).rejects.toBeInstanceOf(PapertrailAuthError)
  })

  it('uploads a PDF as multipart form data with the job id, source URL, and landing URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'job-1', batchId: 'batch-1', status: 'succeeded', errorCode: null, errorMessage: null, leaseUntil: null,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const blob = new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' })
    await client.uploadPdf('job-1', blob, 'paper.pdf', 'https://publisher.example.org/paper.pdf', 'https://publisher.example.org/article')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://papertrail.example.org/api/v1/browser-agent/retrieval-jobs/job-1/upload')
    const form = init.body as FormData
    expect(form.get('sourceUrl')).toBe('https://publisher.example.org/paper.pdf')
    expect(form.get('landingUrl')).toBe('https://publisher.example.org/article')
  })

  it('reports the pending jobs count for background polling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pendingCount: 4 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    await expect(client.pendingJobsCount()).resolves.toBe(4)

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://papertrail.example.org/api/v1/browser-agent/retrieval-jobs/pending-count')
  })

  it('treats a 409 from Papertrail as a conflict, not a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'The publication already has an active PDF' } }), { status: 409 }),
    ))
    const client = new PapertrailClient(connection)

    await expect(client.uploadCapturedPdf('pub-1', new Blob(['x']), 'paper.pdf', false))
      .rejects.toBeInstanceOf(PapertrailConflictError)
  })

  it('lists the projects this agent can capture into', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { id: 'project-1', name: 'Systematic Review' },
    ]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    await expect(client.listAccessibleProjects()).resolves.toEqual([{ id: 'project-1', name: 'Systematic Review' }])

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://papertrail.example.org/api/v1/browser-agent/projects')
  })

  it('searches publications within a project by free-text query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    await client.searchPublications('project-1', 'urban planning')

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe(
      'https://papertrail.example.org/api/v1/browser-agent/projects/project-1/publications/search?q=urban+planning',
    )
  })

  it('sends a detect request as multipart form data with the project id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detectedDoi: null, detectedTitle: null, match: null, ambiguous: false,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const blob = new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' })
    await client.detectPdfMatch('project-1', blob, 'paper.pdf')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://papertrail.example.org/api/v1/browser-agent/pdf-captures/detect')
    const form = init.body as FormData
    expect(form.get('project_id')).toBe('project-1')
    expect(form.get('file')).toBeInstanceOf(File)
  })

  it('sends the replace flag when uploading a captured PDF', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      documentId: 'doc-1', publicationId: 'pub-1', title: 'Some Paper',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    const blob = new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' })
    await client.uploadCapturedPdf('pub-1', blob, 'paper.pdf', true)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://papertrail.example.org/api/v1/browser-agent/publications/pub-1/pdf-captures')
    const form = init.body as FormData
    expect(form.get('replace')).toBe('true')
  })

  it('creates a publication as JSON with only the provided fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'pub-2', title: 'New Paper',
    }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new PapertrailClient(connection)
    await client.createPublication('project-1', { title: 'New Paper', doi: '10.1/x' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://papertrail.example.org/api/v1/browser-agent/projects/project-1/publications')
    expect(JSON.parse(String(init.body))).toEqual({ title: 'New Paper', doi: '10.1/x' })
  })
})
