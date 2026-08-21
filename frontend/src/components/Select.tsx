import type { SelectHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export function Select({ className, multiple, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      multiple={multiple}
      className={cn(
        'min-h-11 rounded-sm border border-border-strong bg-bg-elevated px-3 py-2.5 text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-text-muted focus:border-primary focus:bg-surface-raised focus:shadow-[0_0_0_3px_var(--color-focus)] focus:outline-none',
        multiple ? 'w-full' : 'w-fit min-w-[min(12rem,100%)] max-w-full',
        className,
      )}
      {...props}
    />
  )
}
