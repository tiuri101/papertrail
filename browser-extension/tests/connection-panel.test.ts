import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderConnectionPanel } from '../src/shared/connection-panel'
import type { StoredConnection } from '../src/papertrail/types'
import { installChromeMock } from './chrome-mock'

const connection: StoredConnection = {
  serverUrl: 'https://papertrail.example.org',
  agentToken: 'raw-token',
  agentId: 'agent-1',
  displayName: 'Chrome on Desktop',
  extensionVersion: '0.1.0',
}

beforeEach(() => {
  document.body.innerHTML = '<div id="panel"></div>'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderConnectionPanel', () => {
  it('shows the pairing form when there is no stored connection', async () => {
    installChromeMock({ storageGet: async () => ({}) })

    await renderConnectionPanel('panel')

    expect(document.getElementById('pair-form')).not.toBeNull()
    expect(document.getElementById('server-url')).not.toBeNull()
    expect(document.getElementById('disconnect')).toBeNull()
  })

  it('shows the connected state with the device name when a connection is stored', async () => {
    installChromeMock({ storageGet: async () => ({ papertrail_connection: connection }) })

    await renderConnectionPanel('panel')

    expect(document.getElementById('panel')?.textContent).toContain('Chrome on Desktop')
    expect(document.getElementById('disconnect')).not.toBeNull()
    expect(document.getElementById('pair-form')).toBeNull()
  })

  it('escapes a device name containing HTML in the connected view', async () => {
    installChromeMock({
      storageGet: async () => ({
        papertrail_connection: { ...connection, displayName: '<img src=x onerror=alert(1)>' },
      }),
    })

    await renderConnectionPanel('panel')

    expect(document.getElementById('panel')?.querySelector('img')).toBeNull()
  })

  it('pairs successfully and switches to the connected view', async () => {
    const store: Record<string, unknown> = {}
    const chromeMock = installChromeMock({ permissionsContains: async () => true })
    chromeMock.storage.local.get.mockImplementation(async () => store)
    chromeMock.storage.local.set.mockImplementation(async (items: Record<string, unknown>) => {
      Object.assign(store, items)
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agentToken: 'raw-token',
      agent: { id: 'agent-1', displayName: 'Chrome on Desktop', extensionVersion: '0.1.0' },
    }), { status: 201 })))

    await renderConnectionPanel('panel')
    ;(document.getElementById('server-url') as HTMLInputElement).value = 'https://papertrail.example.org'
    ;(document.getElementById('pairing-secret') as HTMLInputElement).value = 'secret'
    ;(document.getElementById('device-name') as HTMLInputElement).value = 'Chrome on Desktop'
    document.getElementById('pair-form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    await vi.waitFor(() => expect(document.getElementById('disconnect')).not.toBeNull())
  })

  it('shows a pairing error without leaving the form', async () => {
    installChromeMock({ storageGet: async () => ({}), permissionsContains: async () => true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid or expired pairing secret' } }), { status: 403 }),
    ))

    await renderConnectionPanel('panel')
    ;(document.getElementById('server-url') as HTMLInputElement).value = 'https://papertrail.example.org'
    ;(document.getElementById('pairing-secret') as HTMLInputElement).value = 'wrong'
    ;(document.getElementById('device-name') as HTMLInputElement).value = 'Chrome on Desktop'
    document.getElementById('pair-form')?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))

    await vi.waitFor(() => {
      const error = document.getElementById('pair-error')
      expect(error?.hidden).toBe(false)
      expect(error?.textContent).toBe('Invalid or expired pairing secret')
    })
    expect(document.getElementById('pair-form')).not.toBeNull()
  })

  it('disconnects and returns to the pairing form', async () => {
    const store: Record<string, unknown> = { papertrail_connection: connection }
    const chromeMock = installChromeMock()
    chromeMock.storage.local.get.mockImplementation(async () => store)
    chromeMock.storage.local.remove.mockImplementation(async () => {
      delete store.papertrail_connection
    })
    const onChange = vi.fn()

    await renderConnectionPanel('panel', { onChange })
    document.getElementById('disconnect')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await vi.waitFor(() => expect(document.getElementById('pair-form')).not.toBeNull())
    expect(onChange).toHaveBeenCalled()
  })
})
