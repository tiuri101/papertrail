import { describe, expect, it } from 'vitest'

import {
  clearConnection,
  loadAutoRetrievalEnabled,
  loadConnection,
  saveConnection,
  setAutoRetrievalEnabled,
} from '../src/shared/storage'
import type { StoredConnection } from '../src/papertrail/types'
import { installChromeMock } from './chrome-mock'

const connection: StoredConnection = {
  serverUrl: 'https://papertrail.example.org',
  agentToken: 'secret-token',
  agentId: 'agent-1',
  displayName: 'Chrome on Desktop',
  extensionVersion: '0.1.0',
}

describe('connection storage', () => {
  it('returns null when nothing is stored', async () => {
    installChromeMock({ storageGet: async () => ({}) })
    expect(await loadConnection()).toBeNull()
  })

  it('saves and loads a connection through chrome.storage.local', async () => {
    const store: Record<string, unknown> = {}
    const chromeMock = installChromeMock({ storageGet: async () => store })
    chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(store, items)
    })

    await saveConnection(connection)
    expect(await loadConnection()).toEqual(connection)
  })

  it('clears the stored connection', async () => {
    const store: Record<string, unknown> = { papertrail_connection: connection }
    const chromeMock = installChromeMock({ storageGet: async () => store })
    chromeMock.storage.local.remove.mockImplementation(async () => {
      delete store.papertrail_connection
    })

    await clearConnection()
    expect(await loadConnection()).toBeNull()
  })
})

describe('auto-retrieval toggle', () => {
  it('defaults to enabled when nothing is stored', async () => {
    installChromeMock({ storageGet: async () => ({}) })
    expect(await loadAutoRetrievalEnabled()).toBe(true)
  })

  it('persists and loads the toggle through chrome.storage.local', async () => {
    const store: Record<string, unknown> = {}
    const chromeMock = installChromeMock({ storageGet: async () => store })
    chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(store, items)
    })

    await setAutoRetrievalEnabled(false)
    expect(await loadAutoRetrievalEnabled()).toBe(false)

    await setAutoRetrievalEnabled(true)
    expect(await loadAutoRetrievalEnabled()).toBe(true)
  })
})
