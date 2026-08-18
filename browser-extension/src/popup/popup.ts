import { loadConnection } from '../papertrail/auth'
import { PapertrailAuthError, PapertrailClient } from '../papertrail/client'
import type { StoredConnection } from '../papertrail/types'
import { escapeHtml, requireElement } from '../shared/dom'
import { loadAutoRetrievalEnabled, setAutoRetrievalEnabled } from '../shared/storage'
import { openExtensionPopupWindow } from '../shared/window'

/** Cheap credential check so a revoked/rejected agent surfaces here, on the
 * page the user actually sees first, instead of only showing up once they
 * open the retrieval window and a job happens to run. Any non-auth failure
 * (server unreachable, etc.) is not this popup's concern -- it's the same
 * best-effort tolerance the background badge refresh already applies. */
async function checkCredentials(connection: StoredConnection): Promise<string | null> {
  try {
    await new PapertrailClient(connection).me()
    return null
  } catch (error) {
    return error instanceof PapertrailAuthError ? error.message : null
  }
}

async function render(): Promise<void> {
  const app = requireElement<HTMLElement>('app')
  const connection = await loadConnection()

  if (!connection) {
    app.innerHTML = `
      <h1>Papertrail Browser Helper</h1>
      <p>Not connected to Papertrail.</p>
      <button id="setup">Set up</button>
    `
    requireElement<HTMLButtonElement>('setup').addEventListener('click', () => {
      void openExtensionPopupWindow('src/options/options.html', { width: 460, height: 560 })
    })
    return
  }

  const [autoRetrievalEnabled, authError] = await Promise.all([
    loadAutoRetrievalEnabled(),
    checkCredentials(connection),
  ])

  app.innerHTML = `
    <h1>Papertrail Browser Helper</h1>
    <p>Connected to:<br /><strong>${escapeHtml(connection.serverUrl)}</strong></p>
    <p>Device:<br /><strong>${escapeHtml(connection.displayName)}</strong></p>
    ${authError ? `
      <div class="alert" role="alert">
        <svg class="alert__icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 1 1 18h18L10 1Zm0 6.5 1 6h-2l1-6ZM9 15h2v2H9v-2Z" />
        </svg>
        <span>${escapeHtml(authError)}</span>
      </div>
      <div class="toolbar">
        <button id="open-settings">Pair again</button>
      </div>
    ` : `
      <div class="toolbar">
        <button id="open-retrieval">Open PDF retrieval</button>
        <button id="open-settings" class="secondary">Settings</button>
      </div>
      <label class="toggle-row">
        <input type="checkbox" id="auto-retrieval-toggle" ${autoRetrievalEnabled ? 'checked' : ''} />
        Automatic retrieval
      </label>
      <p class="muted">
        ${autoRetrievalEnabled
          ? 'Queued PDF retrieval jobs are picked up and processed on their own.'
          : 'Automatic retrieval is off. Use "Open PDF retrieval" to process queued jobs by hand.'}
      </p>
      <div class="callout">
        <svg class="callout__icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2ZM9 9h2v6H9V9Z" />
        </svg>
        <span>
          Retrieval opens in its own window so it can keep running while this popup closes.
        </span>
      </div>
    `}
  `
  requireElement<HTMLButtonElement>('open-settings').addEventListener('click', () => {
    void openExtensionPopupWindow('src/options/options.html', { width: 460, height: 560 })
  })
  if (authError) return

  requireElement<HTMLButtonElement>('open-retrieval').addEventListener('click', () => {
    void openExtensionPopupWindow('src/retrieval/retrieval.html', { width: 460, height: 640 })
  })
  requireElement<HTMLInputElement>('auto-retrieval-toggle').addEventListener('change', (event) => {
    void (async () => {
      await setAutoRetrievalEnabled((event.target as HTMLInputElement).checked)
      await render()
    })()
  })
}

void render()
