import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { IconMoreVertical } from './icons'

/**
 * A "..." row-actions trigger whose menu renders in a portal at the end of
 * <body>, positioned via the trigger's own bounding rect. List/table rows
 * routinely sit inside grids and cards that don't establish a stacking
 * context, so a plain `position: absolute` dropdown can end up painted
 * beneath later sibling rows -- rendering outside that DOM subtree avoids
 * the problem entirely instead of chasing z-index across ancestors.
 */
export function RowActionsMenu({ label, children }: { label: string; children: ReactNode }) {
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

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="icon-button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={toggle}
      >
        <IconMoreVertical />
      </button>
      {open && position ? createPortal(
        <div
          ref={menuRef}
          className="row-actions-menu"
          role="menu"
          aria-label={label}
          style={{ top: position.top, right: position.right }}
        >
          {children}
        </div>,
        document.body,
      ) : null}
    </>
  )
}
