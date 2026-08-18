import { disconnect, loadConnection, PairingError, pairWithServer } from '../papertrail/auth'
import { escapeHtml, requireElement } from './dom'

export interface ConnectionPanelOptions {
  /** Called after the connection state actually changes (paired or
   * disconnected), so a caller embedding this panel (e.g. the popup, which
   * also shows an "Open PDF retrieval" button only while connected) can
   * refresh anything else that depends on it. */
  onChange?: () => void
}

/**
 * Renders the pairing form (when disconnected) or the current connection +
 * disconnect action (when connected) into the element with the given id,
 * and wires up its own event handlers. Shared by the popup -- so pairing
 * happens right inside the toolbar dropdown, with Chrome's native
 * dismiss-on-click-outside behavior, rather than a separate window -- and
 * by the options page reachable from chrome://extensions.
 */
export async function renderConnectionPanel(
  containerId: string,
  options: ConnectionPanelOptions = {},
): Promise<void> {
  const container = requireElement<HTMLElement>(containerId)
  const connection = await loadConnection()

  if (connection) {
    container.innerHTML = `
      <section class="card">
        <p>Connected to:<br /><strong>${escapeHtml(connection.serverUrl)}</strong></p>
        <p>Device name:<br /><strong>${escapeHtml(connection.displayName)}</strong></p>
        <button id="disconnect" class="danger">Disconnect / forget this Papertrail server</button>
        <p class="muted">
          This only forgets the connection on this computer. To revoke the credential itself
          (e.g. after losing a device), use Papertrail &rarr; Account Settings &rarr; Browser Helpers.
        </p>
      </section>
    `
    requireElement<HTMLButtonElement>('disconnect').addEventListener('click', () => {
      void (async () => {
        await disconnect()
        options.onChange?.()
        await renderConnectionPanel(containerId, options)
      })()
    })
    return
  }

  container.innerHTML = `<pair
    <p class="muted">
      Pair this browser with your Papertrail account. Generate a pairing secret from
      Papertrail &rarr; Account Settings &rarr; Browser Helpers &rarr; Pair new browser helper.
    </p>
    <form id="pair-form">
      <label>
        Papertrail server URL
        <input id="server-url" type="text" placeholder="https://papertrail.example.org" required />
      </label>
      <label>
        Pairing secret
        <input id="pairing-secret" type="text" required />
      </label>
      <label>
        Device name
        <input id="device-name" type="text" placeholder="Chrome on Desktop" value="Chrome on Desktop" required />
      </label>
      <button type="submit" id="pair-submit">Pair</button>
    </form>
    <p id="pair-error" class="error" role="alert" hidden></p>
  `

  const form = requireElement<HTMLFormElement>('pair-form')
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void handlePairSubmit(containerId, options)
  })
}

async function handlePairSubmit(containerId: string, options: ConnectionPanelOptions): Promise<void> {
  const errorEl = requireElement<HTMLParagraphElement>('pair-error')
  const submitButton = requireElement<HTMLButtonElement>('pair-submit')
  errorEl.hidden = true
  submitButton.disabled = true
  try {
    const serverUrl = requireElement<HTMLInputElement>('server-url').value
    const pairingSecret = requireElement<HTMLInputElement>('pairing-secret').value
    const deviceName = requireElement<HTMLInputElement>('device-name').value
    await pairWithServer(serverUrl, pairingSecret, deviceName)
    options.onChange?.()
    await renderConnectionPanel(containerId, options)
  } catch (error) {
    errorEl.textContent = error instanceof PairingError || error instanceof Error
      ? error.message
      : 'Pairing failed'
    errorEl.hidden = false
    submitButton.disabled = false
  }
}
