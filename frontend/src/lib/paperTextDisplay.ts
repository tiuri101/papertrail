export type PaperFontFamily = 'system' | 'serif' | 'sans' | 'monospace' | 'ibmPlexCondensed'
export type PaperFontSize = 'sm' | 'md' | 'lg' | 'xl'

export interface PaperTextDisplay {
  fontFamily: PaperFontFamily
  fontSize: PaperFontSize
}

export const DEFAULT_PAPER_TEXT_DISPLAY: PaperTextDisplay = {
  fontFamily: 'system',
  fontSize: 'md',
}

// The namespaced key this feature occupies inside the reviewer's persisted
// `uiPreferences` blob (see hooks/useUiPreferences.ts).
export const PAPER_TEXT_DISPLAY_PREFERENCE_KEY = 'paperTextDisplay'

export const PAPER_FONT_FAMILY_OPTIONS: { value: PaperFontFamily; label: string; stack: string }[] = [
  { value: 'system', label: 'Default', stack: 'inherit' },
  { value: 'serif', label: 'Serif', stack: 'Georgia, Cambria, "Times New Roman", Times, serif' },
  { value: 'sans', label: 'Sans-serif', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { value: 'monospace', label: 'Monospace', stack: '"Cascadia Code", "Courier New", Courier, monospace' },
  { value: 'ibmPlexCondensed', label: 'IBM Plex Sans Condensed', stack: '"IBM Plex Sans Condensed", "Helvetica Neue", Arial, sans-serif' },
]

export const PAPER_FONT_SIZE_OPTIONS: { value: PaperFontSize; label: string; rem: number }[] = [
  { value: 'sm', label: 'Small', rem: 0.9 },
  { value: 'md', label: 'Medium', rem: 1 },
  { value: 'lg', label: 'Large', rem: 1.15 },
  { value: 'xl', label: 'Extra large', rem: 1.35 },
]

export function paperFontFamilyStack(value: PaperFontFamily): string {
  return PAPER_FONT_FAMILY_OPTIONS.find((option) => option.value === value)?.stack ?? 'inherit'
}

export function paperFontSizeRem(value: PaperFontSize): number {
  return PAPER_FONT_SIZE_OPTIONS.find((option) => option.value === value)?.rem ?? 1
}

// The reviewer's chosen size sets the *abstract* size; the title renders at
// this multiple of it, matching the app's default h2:p ratio (1.25rem vs.
// 1rem) so picking "Medium" reproduces the existing look exactly and other
// sizes keep the title visually senior to the abstract.
const PAPER_TITLE_SIZE_SCALE = 1.25

export function paperTitleFontSizeRem(value: PaperFontSize): number {
  return paperFontSizeRem(value) * PAPER_TITLE_SIZE_SCALE
}
