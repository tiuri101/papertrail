import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

export function CriterionBadge({ kind, children, className }: { kind?: string; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex min-w-[2.25rem] items-center justify-center rounded-full border px-2 py-0.5 text-xs font-extrabold leading-[1.4]',
        kind === 'inclusion'
          ? 'border-[color-mix(in_srgb,var(--color-success)_35%,transparent)] bg-success-container text-success'
          : kind === 'exclusion'
            ? 'border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-danger-container text-danger'
            : 'border-border bg-surface text-text-secondary',
        className,
      )}
      data-criterion-kind={kind}
    >
      {children}
    </span>
  )
}
