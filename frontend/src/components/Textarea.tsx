import type { TextareaHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export function Textarea({ className, rows, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={rows}
      className={cn(
        'w-full resize-y rounded-sm border border-border-strong bg-bg-elevated px-3 py-2.5 text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-[border-color,background-color,box-shadow] duration-150 placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-[var(--button-disabled-opacity)] hover:border-text-muted focus:border-primary focus:bg-surface-raised focus:shadow-[0_0_0_3px_var(--color-focus)] focus:outline-none',
        !rows && 'min-h-[120px]',
        className,
      )}
      {...props}
    />
  )
}
