import type { FieldsetHTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export const fieldsetStyles = 'm-0 grid min-w-0 gap-2 border-0 p-0'

/** Standard semantic fieldset without browser chrome; layout is explicit Tailwind. */
export function Fieldset({ className, ...props }: FieldsetHTMLAttributes<HTMLFieldSetElement>) {
  return <fieldset className={cn(fieldsetStyles, className)} {...props} />
}
