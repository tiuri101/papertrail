import type { ReactNode } from 'react'
import { useState } from 'react'
import { Button } from './Button'

interface ConfirmButtonProps {
  label: string
  confirmLabel?: string
  warning: string
  onConfirm: () => void
  disabled?: boolean
  variant?: 'default' | 'secondary' | 'danger'
  icon?: ReactNode
  className?: string
}

export function ConfirmButton({ label, confirmLabel = 'Confirm', warning, onConfirm, disabled, variant = 'default', icon, className }: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <Button className={className} variant={variant === 'danger' ? 'destructive' : variant === 'secondary' ? 'secondary' : 'primary'} type="button" onClick={() => setConfirming(true)} disabled={disabled}>
        {icon}
        {label}
      </Button>
    )
  }

  return (
    <span className="toolbar" role="alertdialog" aria-label={`Confirm: ${label}`}>
      <span className="error" role="alert">{warning}</span>
      <Button
        className={className}
        variant={variant === 'danger' ? 'destructive' : variant === 'secondary' ? 'secondary' : 'primary'}
        type="button"
        onClick={() => {
          setConfirming(false)
          onConfirm()
        }}
        disabled={disabled}
      >
        {icon}
        {confirmLabel}
      </Button>
      <Button className={className} variant="ghost" type="button" onClick={() => setConfirming(false)} disabled={disabled}>
        Cancel
      </Button>
    </span>
  )
}
