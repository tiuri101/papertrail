import type { ReactNode } from 'react'
import { useState } from 'react'
import { Button, type ButtonSize } from './Button'

interface ConfirmButtonProps {
  label: string
  confirmLabel?: string
  warning: string
  onConfirm: () => void
  disabled?: boolean
  variant?: 'default' | 'secondary' | 'danger'
  icon?: ReactNode
  className?: string
  size?: ButtonSize
}

export function ConfirmButton({ label, confirmLabel = 'Confirm', warning, onConfirm, disabled, variant = 'default', icon, className, size = 'md' }: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false)

  if (!confirming) {
    return (
      <Button className={className} size={size} variant={variant === 'danger' ? 'destructive' : variant === 'secondary' ? 'secondary' : 'primary'} type="button" onClick={() => setConfirming(true)} disabled={disabled}>
        {icon}
        {label}
      </Button>
    )
  }

  return (
    <span className="my-5 mb-0 flex flex-wrap items-start gap-3 rounded-md border border-[rgba(255,127,130,0.28)] bg-danger-container p-4" role="alertdialog" aria-label={`Confirm: ${label}`}>
      <span className="text-danger" role="alert">{warning}</span>
      <Button
        className={className}
        size={size}
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
      <Button className={className} size={size} variant="ghost" type="button" onClick={() => setConfirming(false)} disabled={disabled}>
        Cancel
      </Button>
    </span>
  )
}
