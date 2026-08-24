import type { InputHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

const fieldBase =
  'rounded-sm border border-border-strong bg-bg-elevated text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-[border-color,background-color,box-shadow] duration-150 placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-[var(--button-disabled-opacity)] hover:border-text-muted focus:border-primary focus:bg-surface-raised focus:shadow-[0_0_0_3px_var(--color-focus)] focus:outline-none'

const textFieldBase = cn(fieldBase, 'w-full min-h-11 px-3 py-2.5')

export function Input({ className, type, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  if (type === 'checkbox' || type === 'radio') {
    return (
      <input
        type={type}
        className={cn('m-0 size-[18px] shrink-0 rounded-[4px] accent-primary shadow-none disabled:cursor-not-allowed disabled:opacity-[var(--button-disabled-opacity)]', className)}
        {...props}
      />
    )
  }
  return (
    <input
      type={type}
      className={cn(textFieldBase, type === 'number' && 'w-[min(10rem,100%)]', className)}
      {...props}
    />
  )
}
