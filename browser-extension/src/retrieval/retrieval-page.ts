import { connectedClient } from '../papertrail/auth'
import type { PapertrailClient } from '../papertrail/client'
import type { ClaimedJob } from '../papertrail/types'
import { escapeHtml, requireElement } from '../shared/dom'
import { openExtensionPopupWindow } from '../shared/window'
import { candidateStartUrl } from './engine'
import type { RetrievalSnapshot } from './session'
import { RetrievalSession } from './session'

let session: RetrievalSession | null = null

async function boot(): Promise<void> {
  const app = requireElement<HTMLElement>('app')
  const client = await connectedClient()
  if (!client) {
    app.innerHTML = `
      <h1>Papertrail PDF Retrieval</h1>
      <p>Not connected to Papertrail.</p>
      <button id="open-settings">Open settings</button>
    `
    requireElement<HTMLButtonElement>('open-settings').addEventListener('click', () => {
      void openExtensionPopupWindow('src/options/options.html', { width: 460, height: 560 })
    })
    return
  }

  session = new RetrievalSession(client, (snapshot) => renderApp(client, snapshot))
  renderApp(client, session.snapshot)
  // No manual confirmation needed: whenever this page is open (whether the
  // user opened it themselves or the service worker opened it for queued
  // work), it starts working through the queue immediately. Pause remains
  // available for anyone who wants to stop it by hand.
  session.start()
}

function publisherOf(job: ClaimedJob): string | null {
  const url = candidateStartUrl(job)
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

const ICON_CHECK = 'M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4.53 6.47-5.5 5.5a.75.75 0 0 1-1.06 0'
  + 'L5.47 10.5a.75.75 0 1 1 1.06-1.06L8.5 11.44l4.97-4.97a.75.75 0 0 1 1.06 1Z'
const ICON_CLOCK = 'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm.75 3.5v4.65l3.4 2.02-.76 1.28-4.14-2.46V5.5h1.5Z'
const ICON_WARNING = 'M10 1 1 18h18L10 1Zm0 6.5 1 6h-2l1-6ZM9 15h2v2H9v-2Z'

/** No current job, and nothing running: pick an icon/heading pair for the
 * dashed empty-state box, matching the app's "queue is empty" vs "can't
 * reach the server" states instead of showing session.ts's raw status
 * sentence with no visual context. */
function emptyStateFor(statusText: string): { icon: string, heading: string, tone: string } {
  if (/no retrieval jobs/i.test(statusText)) {
    return { icon: ICON_CHECK, heading: 'All caught up', tone: 'success' }
  }
  if (/could not reach/i.test(statusText)) {
    return { icon: ICON_WARNING, heading: 'Connection issue', tone: 'warning' }
  }
  return { icon: ICON_CLOCK, heading: 'Ready to retrieve', tone: 'primary' }
}

function renderApp(client: PapertrailClient, state: RetrievalSnapshot): void {
  const app = requireElement<HTMLElement>('app')
  const publisherLabel = state.currentJob ? publisherOf(state.currentJob) : null

  app.innerHTML = `
    <h1>Papertrail PDF Retrieval</h1>
    <p class="muted">Connected to <strong>${escapeHtml(client.serverUrl)}</strong></p>
    ${state.authError ? `
      <div class="alert" role="alert">
        <svg class="alert__icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M10 1 1 18h18L10 1Zm0 6.5 1 6h-2l1-6ZM9 15h2v2H9v-2Z" />
        </svg>
        <span>${escapeHtml(state.authError)}</span>
      </div>
      <div class="toolbar">
        <button id="open-settings">Pair again</button>
      </div>
    ` : `
      ${state.currentJob ? `
        <section class="card">
          <div class="status-row">
            <span class="status-dot ${state.running ? 'status-dot--active' : ''}"></span>
            <h2>${escapeHtml(state.currentJob.publication.title)}</h2>
          </div>
          ${publisherLabel ? `<p class="muted">Publisher: ${escapeHtml(publisherLabel)}</p>` : ''}
          <p class="muted" role="status">${escapeHtml(state.statusText)}</p>
        </section>
      ` : state.running ? `
        <div class="status-row">
          <span class="status-dot status-dot--active"></span>
          <p class="muted" role="status">${escapeHtml(state.statusText)}</p>
        </div>
      ` : (() => {
        const emptyState = emptyStateFor(state.statusText)
        return `
          <div class="empty-state empty-state--${emptyState.tone}">
            <span class="empty-state__icon" aria-hidden="true">
              <svg viewBox="0 0 20 20"><path d="${emptyState.icon}" /></svg>
            </span>
            <h3>${escapeHtml(emptyState.heading)}</h3>
            <p class="muted" role="status">${escapeHtml(state.statusText)}</p>
          </div>
        `
      })()}
      ${state.pendingPermissionOrigin ? `
        <div class="callout callout--warning">
          <svg class="callout__icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 1 1 18h18L10 1Zm0 6.5 1 6h-2l1-6ZM9 15h2v2H9v-2Z" />
          </svg>
          <span>Papertrail needs permission to visit publisher websites (any HTTPS
          site) to retrieve PDFs on your behalf.</span>
        </div>
        <div class="toolbar">
          <button id="allow-access">Allow access</button>
        </div>
      ` : ''}
      <ul class="stats">
        <li class="pill pill--success">${state.counters.retrieved} retrieved</li>
        <li class="pill pill--warning">${state.counters.attention} require attention</li>
      </ul>
      ${state.lastOutcomeMessage ? `<p class="muted">${escapeHtml(state.lastOutcomeMessage)}</p>` : ''}
      <div class="toolbar">
        ${state.running ? '<button id="pause" class="secondary">Pause</button>' : '<button id="start">Start</button>'}
      </div>
    `}
  `

  document.getElementById('start')?.addEventListener('click', () => session?.start())
  document.getElementById('pause')?.addEventListener('click', () => session?.pause())
  document.getElementById('allow-access')?.addEventListener('click', () => {
    void session?.grantPermissionAndResume()
  })
  document.getElementById('open-settings')?.addEventListener('click', () => {
    void openExtensionPopupWindow('src/options/options.html', { width: 460, height: 560 })
  })
}

void boot()
