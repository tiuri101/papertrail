import { vi } from 'vitest'

export interface ChromeMockOverrides {
  storageGet?: (keys: unknown) => Promise<Record<string, unknown>>
  permissionsContains?: (query: chrome.permissions.Permissions) => Promise<boolean>
  permissionsRequest?: (query: chrome.permissions.Permissions) => Promise<boolean>
  windowsGetCurrent?: () => Promise<chrome.windows.Window>
  windowsCreate?: (data: chrome.windows.CreateData) => Promise<chrome.windows.Window>
  offscreenHasDocument?: boolean
}

/** Installs a minimal chrome.* mock on globalThis for one test file/case. */
export function installChromeMock(overrides: ChromeMockOverrides = {}) {
  let offscreenDocumentOpen = overrides.offscreenHasDocument ?? false
  const mock = {
    storage: {
      local: {
        get: vi.fn(overrides.storageGet ?? (async () => ({}))),
        set: vi.fn(async (_items: Record<string, unknown>) => undefined),
        remove: vi.fn(async (_keys: string | string[]) => undefined),
      },
      onChanged: { addListener: vi.fn() },
    },
    permissions: {
      contains: vi.fn(overrides.permissionsContains ?? (async () => true)),
      request: vi.fn(overrides.permissionsRequest ?? (async () => true)),
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: '0.1.0' }) as chrome.runtime.ManifestV3),
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      openOptionsPage: vi.fn(),
      getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
      setTitle: vi.fn(async () => undefined),
    },
    tabs: {
      create: vi.fn(async () => undefined),
    },
    alarms: {
      create: vi.fn((_name: string, _info: chrome.alarms.AlarmCreateInfo) => undefined),
      onAlarm: { addListener: vi.fn() },
    },
    offscreen: {
      hasDocument: vi.fn(async () => offscreenDocumentOpen),
      createDocument: vi.fn(async (_options: chrome.offscreen.CreateParameters) => {
        offscreenDocumentOpen = true
      }),
      closeDocument: vi.fn(async () => {
        offscreenDocumentOpen = false
      }),
    },
    windows: {
      create: vi.fn(
        overrides.windowsCreate
        ?? (async (_data: chrome.windows.CreateData) => ({
          id: 1,
          focused: false,
          alwaysOnTop: false,
          incognito: false,
        }) as chrome.windows.Window),
      ),
      remove: vi.fn(async (_windowId: number) => undefined),
      onRemoved: { addListener: vi.fn() },
      getCurrent: vi.fn(
        overrides.windowsGetCurrent
        ?? (async () => ({
          id: 1,
          left: 100,
          top: 50,
          width: 1200,
          height: 900,
          focused: true,
          alwaysOnTop: false,
          incognito: false,
        }) as chrome.windows.Window),
      ),
    },
  }
  vi.stubGlobal('chrome', mock)
  return mock
}
