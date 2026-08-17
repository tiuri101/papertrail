import { describe, expect, it } from 'vitest'

import { openExtensionPopupWindow } from '../src/shared/window'
import { installChromeMock } from './chrome-mock'

describe('openExtensionPopupWindow', () => {
  it('opens the given extension page as a chrome-less popup-type window', async () => {
    const chromeMock = installChromeMock({
      windowsGetCurrent: async () => ({
        id: 1, left: 100, top: 50, width: 1200, height: 900,
        focused: true, alwaysOnTop: false, incognito: false,
      } as chrome.windows.Window),
    })

    await openExtensionPopupWindow('src/options/options.html', { width: 460, height: 560 })

    expect(chromeMock.windows.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test-id/src/options/options.html',
      type: 'popup',
      width: 460,
      height: 560,
      left: 828,
      top: 140,
      focused: true,
    })
  })

  it('falls back to sensible default dimensions', async () => {
    const chromeMock = installChromeMock()

    await openExtensionPopupWindow('src/retrieval/retrieval.html')

    const call = chromeMock.windows.create.mock.calls[0]?.[0] as chrome.windows.CreateData
    expect(call.width).toBeGreaterThan(0)
    expect(call.height).toBeGreaterThan(0)
    expect(call.type).toBe('popup')
  })

  it('anchors near the top-right corner of the current browser window', async () => {
    const chromeMock = installChromeMock({
      windowsGetCurrent: async () => ({
        id: 1, left: 0, top: 0, width: 1600, height: 1000,
        focused: true, alwaysOnTop: false, incognito: false,
      } as chrome.windows.Window),
    })

    await openExtensionPopupWindow('src/retrieval/retrieval.html', { width: 460, height: 640 })

    const call = chromeMock.windows.create.mock.calls[0]?.[0] as chrome.windows.CreateData
    expect(call.left).toBe(1600 - 460 - 12)
    expect(call.top).toBe(90)
  })

  it('does not clip off the left edge when the browser window is narrower than the popup', async () => {
    const chromeMock = installChromeMock({
      windowsGetCurrent: async () => ({
        id: 1, left: 200, top: 20, width: 300, height: 800,
        focused: true, alwaysOnTop: false, incognito: false,
      } as chrome.windows.Window),
    })

    await openExtensionPopupWindow('src/retrieval/retrieval.html', { width: 460, height: 640 })

    const call = chromeMock.windows.create.mock.calls[0]?.[0] as chrome.windows.CreateData
    expect(call.left).toBe(200)
  })

  it('lets Chrome choose a position when window geometry is unavailable', async () => {
    const chromeMock = installChromeMock({
      windowsGetCurrent: async () => ({
        id: 1, focused: true, alwaysOnTop: false, incognito: false,
      } as chrome.windows.Window),
    })

    await openExtensionPopupWindow('src/retrieval/retrieval.html', { width: 460, height: 640 })

    const call = chromeMock.windows.create.mock.calls[0]?.[0] as chrome.windows.CreateData
    expect(call.left).toBeUndefined()
    expect(call.top).toBeUndefined()
  })
})
