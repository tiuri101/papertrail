import type { ReactNode } from 'react'
import { useState } from 'react'

interface ConfirmButtonProps {
  label: string
  confirmLabel?: string
  warning: string
  onConfirm: () => void
  disabled?: boolean
  variant?: 'default' | 'danger'
  icon?: ReactNode
}

export function ConfirmButton({ label, confirmLabel = 'Confirm', warning, onConfirm, disabled, variant = 'default', icon }: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <button className={variant === 'danger' ? 'button-danger' : undefined} type="button" onClick={() => setConfirming(true)} disabled={disabled}>
        {icon}
        {label}
      </button>
    )
  }

  return (
    <span className="toolbar" role="alertdialog" aria-label={`Confirm: ${label}`}>
      <span className="error" role="alert">{warning}</span>
      <button
        className={variant === 'danger' ? 'button-danger' : undefined}
        type="button"
        onClick={() => {
          setConfirming(false)
          onConfirm()
        }}
        disabled={disabled}
      >
        {icon}
        {confirmLabel}
      </button>
      <button className="button-secondary" type="button" onClick={() => setConfirming(false)} disabled={disabled}>
        Cancel
      </button>
    </span>
  )
}
