export type Theme = 'dark' | 'light'

const THEME_STORAGE_KEY = 'papertrail-theme'

function isTheme(value: string | null): value is Theme {
  return value === 'dark' || value === 'light'
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
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#090e1a' : '#f4f6fb')
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
