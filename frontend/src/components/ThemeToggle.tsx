import { useState } from 'react'

import { persistTheme, type Theme } from '../app/theme'
import { IconButton } from './Button'

function themeFromDocument(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(themeFromDocument)
  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${nextTheme} mode`

  return (
    <IconButton
      variant="outline"
      aria-label={label}
      title={label}
      onClick={() => {
        persistTheme(nextTheme)
        setTheme(nextTheme)
      }}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0 4a1 1 0 0 1-1-1v-1.1a1 1 0 1 1 2 0V21a1 1 0 0 1-1 1Zm0-17.9a1 1 0 0 1-1-1V2a1 1 0 1 1 2 0v1.1a1 1 0 0 1-1 1ZM3.1 13H2a1 1 0 1 1 0-2h1.1a1 1 0 1 1 0 2ZM22 13h-1.1a1 1 0 1 1 0-2H22a1 1 0 1 1 0 2ZM5.7 19.7a1 1 0 0 1-.7-1.7l.8-.8a1 1 0 0 1 1.4 1.4l-.8.8a1 1 0 0 1-.7.3Zm12.5-12.5a1 1 0 0 1-.7-1.7l.8-.8a1 1 0 1 1 1.4 1.4l-.8.8a1 1 0 0 1-.7.3ZM6.5 7.2a1 1 0 0 1-.7-.3L5 6.1a1 1 0 1 1 1.4-1.4l.8.8a1 1 0 0 1-.7 1.7Zm12.5 12.5a1 1 0 0 1-.7-.3l-.8-.8a1 1 0 1 1 1.4-1.4l.8.8a1 1 0 0 1-.7 1.7Z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.7 15.1a8.5 8.5 0 0 1-11.8-11.8A9.5 9.5 0 1 0 20.7 15.1ZM4.5 12a7.5 7.5 0 0 1 3-6 10.5 10.5 0 0 0 10.5 10.5A7.5 7.5 0 0 1 4.5 12Z" />
        </svg>
      )}
    </IconButton>
  )
}
