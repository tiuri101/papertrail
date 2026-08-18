import { describe, expect, it } from 'vitest'

import { badgeStateFor } from '../src/background/service-worker'
import type { StoredConnection } from '../src/papertrail/types'

const connection: StoredConnection = {
  serverUrl: 'https://papertrail.example.org',
  agentToken: 'token',
  agentId: 'agent-1',
  displayName: 'Chrome on Desktop',
  extensionVersion: '0.1.0',
}

describe('badgeStateFor', () => {
  it('shows nothing when not connected, regardless of pending count', () => {
    const state = badgeStateFor(null, 5)
    expect(state.text).toBe('')
    expect(state.title).toMatch(/not connected/i)
  })

  it('shows ON when connected with no pending jobs', () => {
    const state = badgeStateFor(connection, 0)
    expect(state.text).toBe('ON')
    expect(state.title).toContain(connection.serverUrl)
  })

  it('shows the pending count when jobs are waiting', () => {
    const state = badgeStateFor(connection, 3)
    expect(state.text).toBe('3')
    expect(state.title).toMatch(/3 publications waiting/i)
  })

  it('uses singular wording for exactly one pending job', () => {
    const state = badgeStateFor(connection, 1)
    expect(state.title).toMatch(/1 publication waiting/i)
    expect(state.title).not.toMatch(/publications/i)
  })

  it('caps the displayed count instead of showing an unbounded number', () => {
    const state = badgeStateFor(connection, 150)
    expect(state.text).toBe('99+')
  })

  it('uses a distinct color when jobs are pending versus idle', () => {
    const idle = badgeStateFor(connection, 0)
    const pending = badgeStateFor(connection, 2)
    expect(pending.color).not.toBe(idle.color)
  })
})
