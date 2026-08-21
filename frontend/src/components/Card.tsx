import type { HTMLAttributes } from 'react'
import { cn } from '../lib/cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative rounded-lg border border-border bg-linear-to-b from-surface-raised to-surface p-6 shadow-sm',
        '[&>*+*]:mt-5 [&>h2+*]:mt-4',
        className,
      )}
      {...props}
    />
  )
}
