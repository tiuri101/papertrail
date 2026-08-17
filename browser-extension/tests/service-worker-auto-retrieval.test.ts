import { describe, expect, it, vi } from 'vitest'

import { installChromeMock } from './chrome-mock'
import type { ChromeMockOverrides } from './chrome-mock'

/**
 * ensureAutoRetrieval tracks its open window in module-level state, so each
 * test gets a fresh module instance (vi.resetModules + a dynamic import)
 * rather than sharing state with the other tests in this describe block or
 * with tests/service-worker.test.ts's static import.
 */
async function freshEnsureAutoRetrieval(overrides: ChromeMockOverrides) {
  const chromeMock = installChromeMock(overrides)
  vi.resetModules()
  const module = await import('../src/background/service-worker')
  return { ensureAutoRetrieval: module.ensureAutoRetrieval, chromeMock }
}

describe('ensureAutoRetrieval -- publisher access already granted (runs invisibly)', () => {
  const granted = {
    storageGet: async () => ({ papertrail_auto_retrieval_enabled: true }),
    permissionsContains: async () => true,
  }

  it('opens an offscreen document rather than a visible window', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval(granted)

    await ensureAutoRetrieval(3)

    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1)
    expect(chromeMock.windows.create).not.toHaveBeenCalled()
  })

  it('does not open a second offscreen document while one is already open', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval(granted)

    await ensureAutoRetrieval(3)
    await ensureAutoRetrieval(2)

    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1)
  })

  it('closes the offscreen document once the queue is empty', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval(granted)

    await ensureAutoRetrieval(3)
    await ensureAutoRetrieval(0)

    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1)
  })

  it('does not open anything merely because the queue is still empty', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval(granted)

    await ensureAutoRetrieval(0)

    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled()
    expect(chromeMock.windows.create).not.toHaveBeenCalled()
  })

  it('does not open anything when auto-retrieval is disabled', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval({
      ...granted,
      storageGet: async () => ({ papertrail_auto_retrieval_enabled: false }),
    })

    await ensureAutoRetrieval(3)

    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled()
    expect(chromeMock.windows.create).not.toHaveBeenCalled()
  })
})

describe('ensureAutoRetrieval -- publisher access not yet granted (needs a visible window)', () => {
  const notGranted = {
    storageGet: async () => ({ papertrail_auto_retrieval_enabled: true }),
    permissionsContains: async () => false,
  }

  it('opens a visible retrieval window instead of an offscreen document', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval(notGranted)

    await ensureAutoRetrieval(3)

    expect(chromeMock.windows.create).toHaveBeenCalledTimes(1)
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled()
    const call = chromeMock.windows.create.mock.calls[0]?.[0] as chrome.windows.CreateData
    expect(call.url).toContain('src/retrieval/retrieval.html')
    expect(call.focused).toBe(false)
  })

  it('does not open a second window while one is already open', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval(notGranted)

    await ensureAutoRetrieval(3)
    await ensureAutoRetrieval(2)

    expect(chromeMock.windows.create).toHaveBeenCalledTimes(1)
  })

  it('closes the window once the queue is empty', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval(notGranted)

    await ensureAutoRetrieval(3)
    await ensureAutoRetrieval(0)

    expect(chromeMock.windows.remove).toHaveBeenCalledWith(1)
  })

  it('does not open a window when auto-retrieval is disabled', async () => {
    const { ensureAutoRetrieval, chromeMock } = await freshEnsureAutoRetrieval({
      ...notGranted,
      storageGet: async () => ({ papertrail_auto_retrieval_enabled: false }),
    })

    await ensureAutoRetrieval(3)

    expect(chromeMock.windows.create).not.toHaveBeenCalled()
  })
})
