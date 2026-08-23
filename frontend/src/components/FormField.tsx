import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

const labelTextClass = 'text-[0.9rem] font-semibold text-text-secondary'

export interface FormFieldProps {
  label: ReactNode
  /** Matches the label to its control; required unless `label` itself wraps `children`. */
  htmlFor?: string
  /** Extra content next to the label, e.g. an info tooltip. */
  accessory?: ReactNode
  className?: string
  children: ReactNode
}

/**
 * A label + control (+ optional accessory) group. When there's no accessory, the label wraps
 * the control directly (matching plain `<label>Text<input /></label>` markup); an accessory
 * forces the label onto its own row via `htmlFor` so the accessory can sit beside it instead of
 * inside the label.
 */
export function FormField({ label, htmlFor, accessory, className, children }: FormFieldProps) {
  if (!accessory) {
    return (
      <label htmlFor={htmlFor} className={cn('grid gap-2', labelTextClass, className)}>
        {label}
        {children}
      </label>
    )
  }
  return (
    <div className={cn('grid gap-2', className)}>
      <span className={cn('inline-flex items-center gap-2', labelTextClass)}>
        <label htmlFor={htmlFor}>{label}</label>
        {accessory}
      </span>
      {children}
    </div>
  )
}
