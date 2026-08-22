import { hasOriginPermission, originPattern, requestOriginPermission } from '../retrieval/permission-manager'
import { isSafePapertrailServerUrl } from '../retrieval/url-safety'
import { clearConnection, loadConnection, saveConnection } from '../shared/storage'
import { PapertrailClient } from './client'
import type { StoredConnection } from './types'

export { loadConnection }

export class PairingError extends Error {}

/** Sends the one-time pairing secret to the unauthenticated pairing
 * endpoint and stores the resulting agent token. The pairing secret itself
 * is never retained after this call succeeds or fails. */
export async function pairWithServer(
  serverUrl: string,
  pairingSecret: string,
  deviceName: string,
): Promise<StoredConnection> {
  const normalizedUrl = serverUrl.trim().replace(/\/+$/, '')
  if (!isSafePapertrailServerUrl(normalizedUrl)) {
    throw new PairingError(
      'Enter a valid Papertrail server URL (HTTPS, or HTTP for localhost only).',
    )
  }
  const trimmedSecret = pairingSecret.trim()
  if (!trimmedSecret) {
    throw new PairingError('Enter the pairing secret shown in Papertrail Account Settings.')
  }
  const trimmedDeviceName = deviceName.trim() || 'Chrome Browser Helper'

  // Extension fetches are only exempt from the target site's CORS policy
  // when the extension actually holds a host permission for that origin.
  // Without it, this request would go out as an ordinary cross-origin
  // fetch and fail against Papertrail's CORS policy before ever reaching
  // the server -- indistinguishable from the server being unreachable.
  // This must run before any other `await` so the click that triggered
  // pairing still counts as the user gesture Chrome requires to prompt.
  const origin = originPattern(normalizedUrl)
  if (!(await hasOriginPermission(origin))) {
    const granted = await requestOriginPermission(origin)
    if (!granted) {
      throw new PairingError(
        `Papertrail needs permission to access ${origin} to pair. Allow access when Chrome `
        + 'prompts you, then try again.',
      )
    }
  }

  let response: Response
  try {
    response = await fetch(`${normalizedUrl}/api/v1/browser-agents/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairingSecret: trimmedSecret,
        deviceName: trimmedDeviceName,
        extensionVersion: chrome.runtime.getManifest().version,
      }),
    })
  } catch {
    throw new PairingError(`Could not reach ${normalizedUrl}. Check the server URL and try again.`)
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new PairingError(body?.error?.message ?? `Pairing failed (HTTP ${response.status})`)
  }

  const body = await response.json() as {
    agentToken: string
    agent: { id: string; displayName: string; extensionVersion: string | null }
  }
  const connection: StoredConnection = {
    serverUrl: normalizedUrl,
    agentToken: body.agentToken,
    agentId: body.agent.id,
    displayName: body.agent.displayName,
    extensionVersion: body.agent.extensionVersion ?? chrome.runtime.getManifest().version,
  }
  await saveConnection(connection)
  return connection
}

export async function connectedClient(): Promise<PapertrailClient | null> {
  const connection = await loadConnection()
  return connection ? new PapertrailClient(connection) : null
}

export async function disconnect(): Promise<void> {
  await clearConnection()
}
