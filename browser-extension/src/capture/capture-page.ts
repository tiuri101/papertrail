import { connectedClient } from '../papertrail/auth'
import type { PublicationPickerResult } from '../papertrail/types'
import { escapeHtml, requireElement } from '../shared/dom'
import { openExtensionPopupWindow } from '../shared/window'
import type { CaptureSnapshot } from './capture-session'
import { CaptureSession } from './capture-session'

let session: CaptureSession | null = null

interface LocationParams {
  tabUrl: string
  projectId: string | null
  projectName: string | null
}

function paramsFromLocation(): LocationParams {
  const params = new URLSearchParams(window.location.search)
  return {
    tabUrl: params.get('tabUrl') ?? '',
    projectId: params.get('projectId'),
    projectName: params.get('projectName'),
  }
}

async function boot(): Promise<void> {
  const app = requireElement<HTMLElement>('app')
  const client = await connectedClient()
  if (!client) {
    app.innerHTML = `
      <h1>Capture PDF</h1>
      <p>Not connected to Papertrail.</p>
      <button id="open-settings">Open settings</button>
    `
    requireElement<HTMLButtonElement>('open-settings').addEventListener('click', () => {
      void openExtensionPopupWindow('src/options/options.html', { width: 460, height: 560 })
    })
    return
  }

  const { tabUrl, projectId, projectName } = paramsFromLocation()
  session = new CaptureSession(client, tabUrl, projectId, projectName, (snapshot) => renderApp(snapshot))
  renderApp(session.snapshot)
  void session.start()
}

function resultRow(result: PublicationPickerResult): string {
  const details = [result.authors, result.publicationYear?.toString()].filter(Boolean).join(' · ')
  return `
    <button class="secondary result-row" data-publication-id="${escapeHtml(result.id)}" data-publication-title="${escapeHtml(result.title)}">
      <strong>${escapeHtml(result.title)}</strong>
      ${details ? `<span class="muted">${escapeHtml(details)}</span>` : ''}
    </button>
  `
}

function renderApp(state: CaptureSnapshot): void {
  const app = requireElement<HTMLElement>('app')

  app.innerHTML = `
    <h1>Capture PDF</h1>
    <p class="muted">${escapeHtml(state.tabUrl || 'No page detected')}</p>
    ${state.projectName ? `<p class="muted">Project: <strong>${escapeHtml(state.projectName)}</strong></p>` : ''}
    ${body(state)}
  `

  wireListeners()
}

function body(state: CaptureSnapshot): string {
  switch (state.phase) {
    case 'starting':
    case 'working':
      return `
        <div class="status-row">
          <span class="status-dot status-dot--active"></span>
          <p class="muted" role="status">${escapeHtml(state.message)}</p>
        </div>
      `
    case 'permission_needed':
      return `
        <div class="callout callout--warning">
          <svg class="callout__icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 1 1 18h18L10 1Zm0 6.5 1 6h-2l1-6ZM9 15h2v2H9v-2Z" />
          </svg>
          <span>${escapeHtml(state.message)}</span>
        </div>
        <div class="toolbar">
          <button id="allow-access">Allow access</button>
        </div>
      `
    case 'not_pdf':
    case 'no_project':
    case 'error':
      return `
        <div class="alert" role="alert">
          <svg class="alert__icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 1 1 18h18L10 1Zm0 6.5 1 6h-2l1-6ZM9 15h2v2H9v-2Z" />
          </svg>
          <span>${escapeHtml(state.message)}</span>
        </div>
        <div class="toolbar">
          ${state.authError ? '<button id="open-settings">Pair again</button>' : '<button id="close" class="secondary">Close</button>'}
        </div>
      `
    case 'search':
      return `
        <label for="search-input">Find the publication</label>
        <input type="text" id="search-input" placeholder="Search by title, author or DOI…" value="${escapeHtml(state.searchQuery)}" autocomplete="off" />
        <div class="toolbar" style="flex-direction: column; align-items: stretch;">
          ${state.searchResults.length > 0
            ? state.searchResults.map(resultRow).join('')
            : state.searchQuery.trim()
              ? '<p class="muted">No matching publications found.</p>'
              : ''}
        </div>
        <div class="toolbar">
          <button id="show-create-publication" class="secondary">+ Create new publication</button>
        </div>
      `
    case 'create_publication':
      return `
        <p class="muted">Not in Papertrail yet? Add it now and attach this PDF.</p>
        <form id="create-publication-form">
          <label for="new-title">Title
            <input type="text" id="new-title" required autocomplete="off" value="${escapeHtml(state.detectedTitle ?? '')}" />
          </label>
          <label for="new-authors">Authors
            <input type="text" id="new-authors" autocomplete="off" value="${escapeHtml(state.detectedAuthors ?? '')}" />
          </label>
          <label for="new-year">Year
            <input type="text" id="new-year" inputmode="numeric" autocomplete="off" value="${state.detectedYear ?? ''}" />
          </label>
          <label for="new-doi">DOI
            <input type="text" id="new-doi" autocomplete="off" value="${escapeHtml(state.detectedDoi ?? '')}" />
          </label>
          <div class="toolbar">
            <button type="submit">Create &amp; attach</button>
            <button type="button" id="back-to-search" class="secondary">Back to search</button>
          </div>
        </form>
      `
    case 'confirm_replace':
      return `
        <div class="callout callout--warning">
          <svg class="callout__icon" viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 1 1 18h18L10 1Zm0 6.5 1 6h-2l1-6ZM9 15h2v2H9v-2Z" />
          </svg>
          <span>${escapeHtml(state.message)}</span>
        </div>
        <div class="toolbar">
          <button id="confirm-replace">Replace existing PDF</button>
          <button id="back-to-search" class="secondary">Choose a different publication</button>
        </div>
      `
    case 'success':
      return `
        <div class="empty-state empty-state--success">
          <span class="empty-state__icon" aria-hidden="true">
            <svg viewBox="0 0 20 20"><path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4.53 6.47-5.5 5.5a.75.75 0 0 1-1.06 0L5.47 10.5a.75.75 0 1 1 1.06-1.06L8.5 11.44l4.97-4.97a.75.75 0 0 1 1.06 1Z" /></svg>
          </span>
          <h3>Attached</h3>
          <p class="muted">${escapeHtml(state.message)}</p>
        </div>
        <div class="toolbar">
          <button id="close">Close</button>
        </div>
      `
    default:
      return ''
  }
}

function wireListeners(): void {
  document.getElementById('allow-access')?.addEventListener('click', () => {
    void session?.grantPermissionAndContinue()
  })
  document.getElementById('open-settings')?.addEventListener('click', () => {
    void openExtensionPopupWindow('src/options/options.html', { width: 460, height: 560 })
  })
  document.getElementById('close')?.addEventListener('click', () => window.close())
  document.getElementById('confirm-replace')?.addEventListener('click', () => {
    void session?.confirmReplace()
  })
  document.getElementById('back-to-search')?.addEventListener('click', () => {
    session?.backToSearch()
  })
  document.getElementById('show-create-publication')?.addEventListener('click', () => {
    session?.showCreatePublicationForm()
  })
  document.getElementById('create-publication-form')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const title = (document.getElementById('new-title') as HTMLInputElement).value.trim()
    if (!title) return
    const authors = (document.getElementById('new-authors') as HTMLInputElement).value.trim()
    const yearText = (document.getElementById('new-year') as HTMLInputElement).value.trim()
    const doi = (document.getElementById('new-doi') as HTMLInputElement).value.trim()
    const year = yearText ? Number.parseInt(yearText, 10) : NaN
    void session?.createPublication({
      title,
      ...(authors ? { authors } : {}),
      ...(Number.isFinite(year) ? { publicationYear: year } : {}),
      ...(doi ? { doi } : {}),
    })
  })

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-publication-id]')) {
    button.addEventListener('click', () => {
      void session?.attach(button.dataset.publicationId!, button.dataset.publicationTitle!, false)
    })
  }

  const newTitleInput = document.getElementById('new-title') as HTMLInputElement | null
  newTitleInput?.focus()

  const searchInput = document.getElementById('search-input') as HTMLInputElement | null
  if (searchInput) {
    searchInput.focus()
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length)
    let debounce: ReturnType<typeof setTimeout> | undefined
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce)
      const query = searchInput.value
      debounce = setTimeout(() => void session?.search(query), 250)
    })
  }
}

void boot()
