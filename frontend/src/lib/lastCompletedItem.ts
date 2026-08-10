export interface LastCompletedItem {
  id: string
  title: string
}

// sessionStorage-backed so the "Go Back" affordance survives the page
// remount that happens when navigating away from and back to the
// screening/extraction queue (react-router unmounts these route components).
export function loadLastCompletedItem(key: string): LastCompletedItem | null {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as LastCompletedItem) : null
  } catch {
    return null
  }
}

export function saveLastCompletedItem(key: string, value: LastCompletedItem): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore storage failures (e.g. private browsing)
  }
}

export function lastExtractionKey(projectId: string): string {
  return `papertrail:last-extraction:${projectId}`
}

export function lastScreeningKey(projectId: string, stage: string): string {
  return `papertrail:last-screening:${projectId}:${stage}`
}
