import { loadConnection } from '../papertrail/auth'
import { PapertrailAuthError, PapertrailClient } from '../papertrail/client'
import type { AgentProject, StoredConnection } from '../papertrail/types'
import { escapeHtml, requireElement } from '../shared/dom'
import {
  loadAutoRetrievalEnabled,
  loadLastCaptureProjectId,
  saveLastCaptureProjectId,
  setAutoRetrievalEnabled,
} from '../shared/storage'
import { openExtensionPopupWindow } from '../shared/window'
import { resolveSelectedProjectId } from './project-selection'

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

/** Best-effort: an empty list here just means the capture button gets
 * disabled below, not a hard failure of the rest of the popup. */
async function loadProjects(connection: StoredConnection): Promise<AgentProject[]> {
  try {
    return await new PapertrailClient(connection).listAccessibleProjects()
  } catch {
    return []
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

  const [autoRetrievalEnabled, authError, projects, rememberedProjectId] = await Promise.all([
    loadAutoRetrievalEnabled(),
    checkCredentials(connection),
    loadProjects(connection),
    loadLastCaptureProjectId(),
  ])
  const selectedProjectId = resolveSelectedProjectId(projects, rememberedProjectId)
  if (selectedProjectId && selectedProjectId !== rememberedProjectId) {
    void saveLastCaptureProjectId(selectedProjectId)
  }

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
      ${projects.length > 1 ? `
        <label for="project-select">Capture project
          <select id="project-select">
            ${projects.map((project) => `
              <option value="${escapeHtml(project.id)}" ${project.id === selectedProjectId ? 'selected' : ''}>
                ${escapeHtml(project.name)}
              </option>
            `).join('')}
          </select>
        </label>
      ` : ''}
      <div class="toolbar">
        <button id="open-capture" class="secondary" ${selectedProjectId ? '' : 'disabled'}>Capture PDF from this tab</button>
      </div>
      ${selectedProjectId ? '' : `
        <p class="muted">No project currently grants you full-text review access, so there's nothing to capture into.</p>
      `}
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
  requireElement<HTMLButtonElement>('open-capture').addEventListener('click', () => {
    const select = document.getElementById('project-select') as HTMLSelectElement | null
    const project = projects.find((p) => p.id === (select?.value ?? selectedProjectId)) ?? null
    void openCapture(project)
  })
  document.getElementById('project-select')?.addEventListener('change', (event) => {
    void saveLastCaptureProjectId((event.target as HTMLSelectElement).value)
  })
  requireElement<HTMLInputElement>('auto-retrieval-toggle').addEventListener('change', (event) => {
    void (async () => {
      await setAutoRetrievalEnabled((event.target as HTMLInputElement).checked)
      await render()
    })()
  })
}

/** Reads the active tab's URL under the `activeTab` grant this click itself
 * provides, then hands it (and the project already chosen in this popup) to
 * the capture page as plain query parameters -- the capture page never
 * touches chrome.tabs or asks which project again, so it doesn't depend on
 * activeTab's per-tab grant surviving into a separately opened window, and
 * project selection stays a single, always-visible control here rather than
 * a one-off page in the middle of a capture. */
async function openCapture(project: AgentProject | null): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const params = new URLSearchParams({ tabUrl: tab?.url ?? '' })
  if (project) {
    params.set('projectId', project.id)
    params.set('projectName', project.name)
  }
  void openExtensionPopupWindow(`src/capture/capture.html?${params.toString()}`, {
    width: 460,
    height: 640,
  })
}

void render()
