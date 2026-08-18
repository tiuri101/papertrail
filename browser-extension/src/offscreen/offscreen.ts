import { connectedClient } from '../papertrail/auth'
import { RetrievalSession } from '../retrieval/session'

// Runs the retrieval queue to completion with no visible window at all.
// chrome.offscreen documents have a real DOM (unlike the service worker),
// so RetrievalSession/RetrievalEngine work exactly as they do in the
// retrieval popup -- this page just never has any UI shown for it.
//
// If a job comes back needing a new permission grant, there's no user
// gesture available here to request it (chrome.permissions.request()
// requires one), so the session just stops like it would with nobody
// watching. The service worker only opens this offscreen document when
// publisher access is already granted (see service-worker.ts); if that
// somehow changes mid-run, its next periodic check falls back to opening
// the visible retrieval window instead, where the user can grant it.
async function run(): Promise<void> {
  const client = await connectedClient()
  if (!client) return
  const session = new RetrievalSession(client, () => {})
  session.start()
}

void run()
