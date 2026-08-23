import type { KeyboardEvent } from 'react'
import { cn } from '../../lib/cn'

export interface HotkeyButtonProps {
  label: string
  currentKey: string | null
  isCapturing: boolean
  hasConflict: boolean
  onStartCapture: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  onBlur?: () => void
}

export function HotkeyButton({
  label,
  currentKey,
  isCapturing,
  hasConflict,
  onStartCapture,
  onKeyDown,
  onBlur,
}: HotkeyButtonProps) {
  return (
    <button
      type="button"
      aria-label={`${label} hotkey: ${isCapturing ? 'Press a key…' : currentKey || 'Not set'}`}
      className={cn(
        'relative inline-flex min-h-9 min-w-24 items-center justify-center gap-2 rounded-md border text-sm font-semibold transition-colors',
        hasConflict
          ? 'border-danger bg-danger-container text-danger'
          : isCapturing
            ? 'border-text-secondary bg-surface-raised text-text'
            : 'border-border bg-surface-raised text-text-secondary hover:border-border-strong hover:bg-surface-hover',
      )}
      onClick={onStartCapture}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      {isCapturing ? 'Press a key…' : currentKey ? <kbd>{currentKey}</kbd> : 'Not set'}
    </button>
  )
}

