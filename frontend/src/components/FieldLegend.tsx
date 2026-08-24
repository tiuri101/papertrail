import type { HTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export const fieldLegendStyles = 'mb-1 p-0 text-[0.9rem] font-[640] text-text-secondary'

export function FieldLegend({ className, ...props }: HTMLAttributes<HTMLLegendElement>) {
  return <legend className={cn(fieldLegendStyles, className)} {...props} />
}
