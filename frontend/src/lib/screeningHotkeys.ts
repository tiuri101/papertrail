export type ScreeningHotkeyAction = 'include' | 'exclude' | 'uncertain' | 'duplicate' | 'submit'

export type ScreeningHotkeys = Record<ScreeningHotkeyAction, string | null>

export const SCREENING_HOTKEY_ACTIONS: ScreeningHotkeyAction[] = ['include', 'exclude', 'uncertain', 'duplicate', 'submit']

export const DEFAULT_SCREENING_HOTKEYS: ScreeningHotkeys = {
  include: 'i',
  exclude: 'e',
  uncertain: 'u',
  duplicate: 'd',
  submit: 'Enter',
}

const STORAGE_KEY = 'papertrail:screening-hotkeys'

// Custom event so components in the same tab (e.g. the settings page and an
// open screening queue) pick up a hotkey change without a full reload; the
// native "storage" event only fires in *other* tabs.
export const SCREENING_HOTKEYS_CHANGED_EVENT = 'papertrail:screening-hotkeys-changed'

export function loadScreeningHotkeys(): ScreeningHotkeys {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SCREENING_HOTKEYS }
    const parsed = JSON.parse(raw) as Partial<ScreeningHotkeys>
    return { ...DEFAULT_SCREENING_HOTKEYS, ...parsed }
  } catch {
    return { ...DEFAULT_SCREENING_HOTKEYS }
  }
}

export function saveScreeningHotkeys(hotkeys: ScreeningHotkeys): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hotkeys))
  } catch {
    // ignore storage failures (e.g. private browsing)
  }
  window.dispatchEvent(new Event(SCREENING_HOTKEYS_CHANGED_EVENT))
}

const KEY_DISPLAY_NAMES: Record<string, string> = {
  ' ': 'Space',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  escape: 'Esc',
}

export function formatHotkey(key: string | null): string {
  if (!key) return ''
  const lower = key.toLowerCase()
  if (KEY_DISPLAY_NAMES[lower]) return KEY_DISPLAY_NAMES[lower]
  return key.length === 1 ? key.toUpperCase() : key
}
