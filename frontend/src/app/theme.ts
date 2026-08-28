export type Theme = 'dark' | 'light' | 'catppuccin-latte' | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha'

interface ThemeMeta {
  id: Theme
  label: string
  colorScheme: 'dark' | 'light'
  /** Matches this theme's `--color-bg` token, used for the mobile browser chrome color. */
  metaColor: string
}

export const THEMES: ThemeMeta[] = [
  { id: 'dark', label: 'Dark', colorScheme: 'dark', metaColor: '#090e1a' },
  { id: 'light', label: 'Light', colorScheme: 'light', metaColor: '#f4f6fb' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', colorScheme: 'light', metaColor: '#eff1f5' },
  { id: 'catppuccin-frappe', label: 'Catppuccin Frappé', colorScheme: 'dark', metaColor: '#303446' },
  { id: 'catppuccin-macchiato', label: 'Catppuccin Macchiato', colorScheme: 'dark', metaColor: '#24273a' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', colorScheme: 'dark', metaColor: '#1e1e2e' },
]

const THEME_STORAGE_KEY = 'papertrail-theme'

function isTheme(value: string | null): value is Theme {
  return THEMES.some((theme) => theme.id === value)
}

export function getInitialTheme(): Theme {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(storedTheme) ? storedTheme : 'dark'
  } catch {
    return 'dark'
  }
}

export function applyTheme(theme: Theme): void {
  const meta = THEMES.find((candidate) => candidate.id === theme) ?? THEMES[0]
  document.documentElement.dataset.theme = meta.id
  document.documentElement.style.colorScheme = meta.colorScheme
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', meta.metaColor)
}

export function persistTheme(theme: Theme): void {
  applyTheme(theme)
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The selected theme still applies for this session when storage is unavailable.
  }
}

export function initializeTheme(): void {
  applyTheme(getInitialTheme())
}
