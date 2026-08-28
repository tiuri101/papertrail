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

// The namespaced key this feature occupies inside the reviewer's persisted
// `uiPreferences` blob (see hooks/useUiPreferences.ts).
export const SCREENING_HOTKEYS_PREFERENCE_KEY = 'screeningHotkeys'

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
