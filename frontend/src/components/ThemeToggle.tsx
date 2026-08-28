import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { persistTheme, THEMES, type Theme } from '../app/theme'
import { IconButton } from './Button'
import { ActionListItem } from './ActionListItem'
import { IconCheck } from './icons'

function themeFromDocument(): Theme {
  const current = document.documentElement.dataset.theme
  return THEMES.some((theme) => theme.id === current) ? (current as Theme) : 'dark'
}

/**
 * Portal-rendered dropdown for picking one of the app's themes, positioned
 * from the trigger's bounding rect the same way `RowActionsMenu` is — the
 * trigger routinely sits in a header that doesn't establish its own
 * stacking context, so painting the menu at the end of `<body>` avoids
 * z-index fights instead of chasing them.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(themeFromDocument)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const close = () => setOpen(false)
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const toggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    setOpen((current) => !current)
  }

  const select = (next: Theme) => {
    persistTheme(next)
    setTheme(next)
    setOpen(false)
  }

  return (
    <>
      <IconButton
        variant="secondary"
        ref={triggerRef}
        aria-label="Choose theme"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose theme"
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 1.77-4.27 1.5 1.5 0 0 1 1.06-2.56H17a5 5 0 0 0 5-5 8 8 0 0 0-10-8Zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" />
        </svg>
      </IconButton>
      {open && position ? createPortal(
        <div
          ref={menuRef}
          className="fixed z-1000 flex min-w-52 flex-col gap-0.5 rounded-md border border-border bg-surface-raised p-2 shadow-lg"
          role="menu"
          aria-label="Choose theme"
          style={{ top: position.top, right: position.right }}
        >
          {THEMES.map((option) => (
            <ActionListItem
              key={option.id}
              role="menuitem"
              aria-current={option.id === theme}
              onClick={() => select(option.id)}
            >
              <span className="flex-1 text-left">{option.label}</span>
              {option.id === theme ? <IconCheck /> : null}
            </ActionListItem>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  )
}
