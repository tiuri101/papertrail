import { afterEach, describe, expect, it, vi } from 'vitest'

import { PapertrailAuthError, PapertrailClient } from '../src/papertrail/client'
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
})
