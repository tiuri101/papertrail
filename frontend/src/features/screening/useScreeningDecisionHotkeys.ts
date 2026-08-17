import { useEffect, useRef } from 'react'

import {
  loadScreeningHotkeys,
  SCREENING_HOTKEY_ACTIONS,
  SCREENING_HOTKEYS_CHANGED_EVENT,
} from '../../lib/screeningHotkeys'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

interface UseScreeningDecisionHotkeysOptions {
  enabled: boolean
  setOutcome: (outcome: string) => void
  onSubmit?: () => void
}

// Listens for the reviewer's configured include/exclude/uncertain/duplicate
// and submit hotkeys (see AccountSettingsPage) and applies them to the open
// screening item, so a paper can be decided and advanced without the mouse.
// Only active while `enabled` (i.e. while a card with a decision to make is
// actually on screen), and never fires while the reviewer is typing in a
// field such as Notes.
export function useScreeningDecisionHotkeys({ enabled, setOutcome, onSubmit }: UseScreeningDecisionHotkeysOptions): void {
  const setOutcomeRef = useRef(setOutcome)
  setOutcomeRef.current = setOutcome
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit

  useEffect(() => {
    if (!enabled) return

    let byKey = new Map<string, string>()
    const reload = () => {
      const hotkeys = loadScreeningHotkeys()
      byKey = new Map(
        SCREENING_HOTKEY_ACTIONS
          .filter((action) => hotkeys[action])
          .map((action) => [hotkeys[action]!.toLowerCase(), action]),
      )
    }
    reload()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (isTypingTarget(event.target)) return
      const action = byKey.get(event.key.toLowerCase())
      if (!action) return
      event.preventDefault()
      if (action === 'submit') {
        onSubmitRef.current?.()
      } else {
        setOutcomeRef.current(action)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener(SCREENING_HOTKEYS_CHANGED_EVENT, reload)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener(SCREENING_HOTKEYS_CHANGED_EVENT, reload)
      window.removeEventListener('storage', reload)
    }
  }, [enabled])
}
