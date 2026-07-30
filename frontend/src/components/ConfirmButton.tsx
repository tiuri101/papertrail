import { useState } from 'react'

interface ConfirmButtonProps {
  label: string
  confirmLabel?: string
  warning: string
  onConfirm: () => void
  disabled?: boolean
}

export function ConfirmButton({ label, confirmLabel = 'Confirm', warning, onConfirm, disabled }: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} disabled={disabled}>
        {label}
      </button>
    )
  }

  return (
    <span className="toolbar" role="alertdialog" aria-label={`Confirm: ${label}`}>
      <span className="error" role="alert">{warning}</span>
      <button
        type="button"
        onClick={() => {
          setConfirming(false)
          onConfirm()
        }}
        disabled={disabled}
      >
        {confirmLabel}
      </button>
      <button type="button" onClick={() => setConfirming(false)} disabled={disabled}>
        Cancel
      </button>
    </span>
  )
}
