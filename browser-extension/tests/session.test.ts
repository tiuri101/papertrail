import { describe, expect, it, vi } from 'vitest'

import { PapertrailClient } from '../src/papertrail/client'
import type { ClaimedJob } from '../src/papertrail/types'
import type { EngineEvent, EngineJobOutcome, RetrievalEngine } from '../src/retrieval/engine'
import { RetrievalSession } from '../src/retrieval/session'
import { installChromeMock } from './chrome-mock'

const connection = {
  serverUrl: 'https://papertrail.example.org',
  agentToken: 'token',
  agentId: 'agent-1',
  displayName: 'Chrome',
  extensionVersion: '0.1.0',
}

function job(id: string): ClaimedJob {
  return {
    jobId: id,
    batchId: 'batch-1',
    projectId: 'project-1',
    publication: { id: `pub-${id}`, title: `Paper ${id}`, doi: null, publisherUrl: 'https://publisher.example.org/x' },
    maxPdfBytes: 1000,
    leaseUntil: new Date().toISOString(),
  }
}

function fakeEngine(outcomes: EngineJobOutcome[]): (client: PapertrailClient, onEvent: (e: EngineEvent) => void) => RetrievalEngine {
  let index = 0
  return () => ({
    processJob: vi.fn(async () => outcomes[Math.min(index++, outcomes.length - 1)]),
  }) as unknown as RetrievalEngine
}

describe('RetrievalSession', () => {
  it('claims and processes jobs one at a time until none remain', async () => {
    installChromeMock()
    const client = new PapertrailClient(connection)
    vi.spyOn(client, 'claimJob')
      .mockResolvedValueOnce(job('1'))
      .mockResolvedValueOnce(job('2'))
      .mockResolvedValueOnce(null)

    const snapshots: string[] = []
    const session = new RetrievalSession(
      client,
      (snapshot) => snapshots.push(snapshot.statusText),
      fakeEngine([{ status: 'succeeded' }, { status: 'succeeded' }]),
    )

    session.start()
    await vi.waitFor(() => expect(session.snapshot.running).toBe(false))

    expect(session.snapshot.counters.retrieved).toBe(2)
    expect(session.snapshot.statusText).toMatch(/no retrieval jobs/i)
  })

  it('pauses without processing further jobs', async () => {
    installChromeMock()
    const client = new PapertrailClient(connection)
    vi.spyOn(client, 'claimJob').mockResolvedValue(job('1'))

    const session = new RetrievalSession(client, () => {}, fakeEngine([{ status: 'succeeded' }]))
    session.pause()

    expect(session.snapshot.running).toBe(false)
    expect(client.claimJob).not.toHaveBeenCalled()
  })

  it('stops and exposes the origin when a job needs a host permission grant', async () => {
    installChromeMock()
    const client = new PapertrailClient(connection)
    vi.spyOn(client, 'claimJob').mockResolvedValue(job('1'))

    const session = new RetrievalSession(
      client,
      () => {},
      fakeEngine([{ status: 'no_permission', origin: 'https://publisher.example.org/*' }]),
    )
    session.start()

    await vi.waitFor(() => expect(session.snapshot.pendingPermissionOrigin).not.toBeNull())
    expect(session.snapshot.running).toBe(false)
    expect(session.snapshot.pendingPermissionOrigin).toBe('https://publisher.example.org/*')
  })

  it('resumes the loop after the permission is granted', async () => {
    const chromeMock = installChromeMock({ permissionsRequest: async () => true })
    const client = new PapertrailClient(connection)
    vi.spyOn(client, 'claimJob')
      .mockResolvedValueOnce(job('1'))
      .mockResolvedValueOnce(null)

    const session = new RetrievalSession(
      client,
      () => {},
      fakeEngine([{ status: 'no_permission', origin: 'https://publisher.example.org/*' }, { status: 'succeeded' }]),
    )
    session.start()
    await vi.waitFor(() => expect(session.snapshot.pendingPermissionOrigin).not.toBeNull())

    await session.grantPermissionAndResume()
    await vi.waitFor(() => expect(session.snapshot.running).toBe(false))

    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ origins: ['https://publisher.example.org/*'] })
    expect(session.snapshot.pendingPermissionOrigin).toBeNull()
  })
})
