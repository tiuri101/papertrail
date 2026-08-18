import { PapertrailClient } from '../papertrail/client'
import type { StoredConnection } from '../papertrail/types'
import { hasPublisherAccess } from '../retrieval/permission-manager'
import {
  AUTO_RETRIEVAL_STORAGE_KEY,
  CONNECTION_STORAGE_KEY,
  loadAutoRetrievalEnabled,
  loadConnection,
} from '../shared/storage'
import { openExtensionPopupWindow } from '../shared/window'

const PENDING_JOBS_ALARM = 'papertrail-pending-jobs-check'
const CHECK_INTERVAL_MINUTES = 5
const MAX_DISPLAYED_COUNT = 99
const RETRIEVAL_PAGE_PATH = 'src/retrieval/retrieval.html'
const OFFSCREEN_PAGE_PATH = 'src/offscreen/offscreen.html'

// Tracks the auto-opened retrieval window across ticks of the same
// service-worker lifetime, so this never opens more than one. If the
// service worker is evicted and restarted, this simply resets to null --
// worst case is a redundant window is opened, not a lost one.
let autoRetrievalWindowId: number | null = null

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === autoRetrievalWindowId) autoRetrievalWindowId = null
})

async function closeAutoRetrievalWindowIfOpen(): Promise<void> {
  if (autoRetrievalWindowId === null) return
  const windowId = autoRetrievalWindowId
  autoRetrievalWindowId = null
  try {
    await chrome.windows.remove(windowId)
  } catch {
    // Already closed (e.g. the user closed it by hand) -- nothing to do.
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PAGE_PATH,
    reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
    justification: 'Parses publisher landing pages to find PDF links while retrieving queued jobs.',
  })
}

async function closeOffscreenDocumentIfOpen(): Promise<void> {
  if (!(await chrome.offscreen.hasDocument())) return
  try {
    await chrome.offscreen.closeDocument()
  } catch {
    // Already closing/closed -- nothing to do.
  }
}

/**
 * Drives the "no manual confirmation" retrieval experience: while enabled
 * and there's queued work, get jobs processed without anyone opening the
 * popup, closing everything back down once the queue is empty.
 *
 * Prefers a fully invisible `chrome.offscreen` document (it has a real DOM,
 * unlike the service worker, so the same RetrievalSession/RetrievalEngine
 * code that powers the visible retrieval window works there too) -- but
 * only once publisher access has already been granted. Requesting a new
 * permission needs an actual user gesture, which an offscreen document can
 * never provide, so that first grant still has to happen in a visible
 * window; every run after that can stay invisible.
 */
export async function ensureAutoRetrieval(pendingCount: number): Promise<void> {
  if (pendingCount === 0) {
    await closeAutoRetrievalWindowIfOpen()
    await closeOffscreenDocumentIfOpen()
    return
  }

  const autoRetrievalEnabled = await loadAutoRetrievalEnabled()
  if (!autoRetrievalEnabled) return

  if (await hasPublisherAccess()) {
    await closeAutoRetrievalWindowIfOpen()
    await ensureOffscreenDocument()
    return
  }

  await closeOffscreenDocumentIfOpen()
  if (autoRetrievalWindowId !== null) return
  const win = await openExtensionPopupWindow(RETRIEVAL_PAGE_PATH, {
    width: 460,
    height: 640,
    focused: false,
  })
  autoRetrievalWindowId = win.id ?? null
}

export function badgeStateFor(
  connection: StoredConnection | null,
  pendingCount: number,
): { text: string; color: string; title: string } {
  if (!connection) {
    return { text: '', color: '#000000', title: 'Papertrail Browser Helper -- not connected' }
  }
  if (pendingCount > 0) {
    return {
      text: pendingCount > MAX_DISPLAYED_COUNT ? `${MAX_DISPLAYED_COUNT}+` : String(pendingCount),
      color: '#b3621e',
      title: `Papertrail Browser Helper -- ${pendingCount} publication`
        + `${pendingCount === 1 ? '' : 's'} waiting to be retrieved`,
    }
  }
  return {
    text: 'ON',
    color: '#2e7d32',
    title: `Papertrail Browser Helper -- connected to ${connection.serverUrl}`,
  }
}

async function fetchPendingCount(connection: StoredConnection): Promise<number> {
  try {
    return await new PapertrailClient(connection).pendingJobsCount()
  } catch {
    // Best-effort: a revoked agent or unreachable server shouldn't crash
    // badge refresh (or spam this service worker's console on every
    // periodic check) -- it just won't show a count until it recovers.
    return 0
  }
}

async function refreshBadge(): Promise<void> {
  const connection = await loadConnection()
  const pendingCount = connection ? await fetchPendingCount(connection) : 0
  const state = badgeStateFor(connection, pendingCount)
  await chrome.action.setBadgeText({ text: state.text })
  await chrome.action.setBadgeBackgroundColor({ color: state.color })
  await chrome.action.setTitle({ title: state.title })
  if (connection) {
    await ensureAutoRetrieval(pendingCount)
  }
}

function ensurePendingJobsAlarm(): void {
  // create() with an existing name just resets its schedule, so this is
  // safe to call on every startup/install without duplicating alarms.
  chrome.alarms.create(PENDING_JOBS_ALARM, { periodInMinutes: CHECK_INTERVAL_MINUTES })
}

chrome.runtime.onInstalled.addListener(() => {
  ensurePendingJobsAlarm()
  void refreshBadge()
})

chrome.runtime.onStartup.addListener(() => {
  ensurePendingJobsAlarm()
  void refreshBadge()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PENDING_JOBS_ALARM) {
    void refreshBadge()
  }
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === 'local'
    && (CONNECTION_STORAGE_KEY in changes || AUTO_RETRIEVAL_STORAGE_KEY in changes)
  ) {
    void refreshBadge()
  }
})
