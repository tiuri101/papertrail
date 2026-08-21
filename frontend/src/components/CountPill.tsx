import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

interface CountPillProps {
  count: number
  children: ReactNode
  className?: string
  prefix?: ReactNode
}

export function CountPill({ count, children, className, prefix }: CountPillProps) {
  return (
    <p className={cn('mb-5 flex w-fit max-w-full items-center gap-1 rounded-full border border-border bg-surface px-3 py-1.5 text-[0.86rem] leading-[1.35] text-text-secondary', className)}>
      <span className="sr-only">{prefix ? <>{prefix} </> : null}{count} {children}</span>
      {prefix ? <span className="min-w-0" aria-hidden="true">{prefix}</span> : null}
      <strong className="shrink-0 text-text" aria-hidden="true">{count}</strong>
      <span className="min-w-0" aria-hidden="true">{children}</span>
    </p>
  )
}
