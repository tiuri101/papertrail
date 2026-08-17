import { afterEach, describe, expect, it, vi } from 'vitest'

import { PairingError, pairWithServer } from '../src/papertrail/auth'
import { loadConnection } from '../src/shared/storage'
import { installChromeMock } from './chrome-mock'

function pairResponse() {
  return new Response(JSON.stringify({
    agentToken: 'raw-agent-token',
    agent: { id: 'agent-1', displayName: 'Chrome on Desktop', extensionVersion: '0.1.0' },
  }), { status: 201 })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pairWithServer', () => {
  it('requests host permission for the server origin before contacting it', async () => {
    const chromeMock = installChromeMock({ permissionsContains: async () => false })
    const fetchMock = vi.fn().mockResolvedValue(pairResponse())
    vi.stubGlobal('fetch', fetchMock)
    const store: Record<string, unknown> = {}
    chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(store, items)
    })

    await pairWithServer('http://localhost:8000', 'secret', 'Chrome on Desktop')

    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ origins: ['http://localhost/*'] })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/v1/browser-agents/pair',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('does not re-prompt when the host permission is already granted', async () => {
    const chromeMock = installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pairResponse()))

    await pairWithServer('https://papertrail.example.org', 'secret', 'Chrome on Desktop')

    expect(chromeMock.permissions.request).not.toHaveBeenCalled()
  })

  it('fails with a clear message when the user denies the permission prompt, without making a request', async () => {
    installChromeMock({ permissionsContains: async () => false, permissionsRequest: async () => false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(pairWithServer('http://localhost:8000', 'secret', 'Chrome on Desktop'))
      .rejects.toThrow(PairingError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('saves the connection after a successful pairing exchange', async () => {
    const chromeMock = installChromeMock({ permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pairResponse()))
    const store: Record<string, unknown> = {}
    chromeMock.storage.local.get.mockImplementation(async () => store)
    chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(store, items)
    })

    const connection = await pairWithServer('http://localhost:8000', 'secret', 'Chrome on Desktop')

    expect(connection.agentToken).toBe('raw-agent-token')
    expect(connection.serverUrl).toBe('http://localhost:8000')
    expect(await loadConnection()).toEqual(connection)
  })
})
