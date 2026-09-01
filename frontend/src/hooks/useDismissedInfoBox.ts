import { useCallback, useState } from 'react'

const STORAGE_PREFIX = 'papertrail-infobox-dismissed:'

function readDismissed(id: string): boolean {
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${id}`) === '1'
  } catch {
    return false
  }
}

/**
 * Tracks whether a closable `InfoBox` has been dismissed, persisted per `id`
 * in localStorage (deliberately client-only -- unlike `useUiPreference`,
 * dismissing a hint isn't worth syncing across devices).
 */
export function useDismissedInfoBox(id: string) {
  const [dismissed, setDismissed] = useState(() => readDismissed(id))

  const dismiss = useCallback(() => {
    setDismissed(true)
    try {
      window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, '1')
    } catch {
      // The dismissal still applies for this session when storage is unavailable.
    }
  }, [id])

  return { dismissed, dismiss }
}
