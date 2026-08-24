import type { LabelHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export interface FieldLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  /** Use for checkbox/radio rows where the control and text sit side by side. */
  inline?: boolean
}

/** Semantic form label with Papertrail's standard field spacing and typography. */
export function FieldLabel({ inline = false, className, ...props }: FieldLabelProps) {
  return (
    <label
      className={cn(
        inline ? 'flex items-center gap-2' : 'grid gap-2',
        'text-[0.9rem] font-[640] text-text-secondary',
        className,
      )}
      {...props}
    />
  )
}
