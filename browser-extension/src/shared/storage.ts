import type { StoredConnection } from '../papertrail/types'

export const CONNECTION_STORAGE_KEY = 'papertrail_connection'
const CONNECTION_KEY = CONNECTION_STORAGE_KEY

// chrome.storage.local persists across browser restarts, which is required
// here (a paired connection should survive a restart). Chrome's storage
// access-level restriction API (chrome.storage.session.setAccessLevel) only
// applies to chrome.storage.session, not .local, so it cannot be used to
// further restrict this -- ordinary extension-storage isolation (only this
// extension's own contexts can read chrome.storage.local) is what protects
// the stored agent token.
export async function loadConnection(): Promise<StoredConnection | null> {
  const result = await chrome.storage.local.get(CONNECTION_KEY)
  const value = result[CONNECTION_KEY]
  return isStoredConnection(value) ? value : null
}

export async function saveConnection(connection: StoredConnection): Promise<void> {
  await chrome.storage.local.set({ [CONNECTION_KEY]: connection })
}

export async function clearConnection(): Promise<void> {
  await chrome.storage.local.remove(CONNECTION_KEY)
}

// Whether the extension should process queued retrieval jobs on its own
// (auto-opening the retrieval session) or stay fully passive until the user
// opens "Open PDF retrieval" and clicks Start by hand. Defaults on so a
// freshly paired helper does something useful without extra setup; the
// popup exposes a one-click switch to turn it back off.
export const AUTO_RETRIEVAL_STORAGE_KEY = 'papertrail_auto_retrieval_enabled'

export async function loadAutoRetrievalEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(AUTO_RETRIEVAL_STORAGE_KEY)
  const value = result[AUTO_RETRIEVAL_STORAGE_KEY]
  return typeof value === 'boolean' ? value : true
}

export async function setAutoRetrievalEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [AUTO_RETRIEVAL_STORAGE_KEY]: enabled })
}

// Which project the manual-capture flow last attached a PDF to, so a
// reviewer working through several papers for the same project isn't asked
// to pick it again every time. Only ever used as a default -- the picker is
// still shown whenever the remembered project is no longer among the
// agent's accessible projects.
const LAST_CAPTURE_PROJECT_STORAGE_KEY = 'papertrail_last_capture_project_id'

export async function loadLastCaptureProjectId(): Promise<string | null> {
  const result = await chrome.storage.local.get(LAST_CAPTURE_PROJECT_STORAGE_KEY)
  const value = result[LAST_CAPTURE_PROJECT_STORAGE_KEY]
  return typeof value === 'string' ? value : null
}

export async function saveLastCaptureProjectId(projectId: string): Promise<void> {
  await chrome.storage.local.set({ [LAST_CAPTURE_PROJECT_STORAGE_KEY]: projectId })
}

function isStoredConnection(value: unknown): value is StoredConnection {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as StoredConnection).serverUrl === 'string'
    && typeof (value as StoredConnection).agentToken === 'string'
  )
}
