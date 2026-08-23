import type { ReactNode } from 'react'

import { cn } from '../lib/cn'

const toneStyles = {
  info: {
    box: 'border-[color-mix(in_srgb,var(--color-primary)_24%,var(--color-border))] bg-primary-container',
    icon: 'text-primary',
  },
  warning: {
    box: 'border-[color-mix(in_srgb,var(--color-warning)_32%,var(--color-border))] bg-warning-container',
    icon: 'text-warning',
  },
  danger: {
    box: 'border-[color-mix(in_srgb,var(--color-danger)_32%,var(--color-border))] bg-danger-container',
    icon: 'text-danger',
  },
} as const

export function InfoBox({ icon, children, tone = 'info', alert = false, className }: {
  icon: ReactNode
  children: ReactNode
  tone?: keyof typeof toneStyles
  alert?: boolean
  className?: string
}) {
  return (
    <div
      className={cn('flex items-center gap-3 rounded-md border p-4', toneStyles[tone].box, className)}
      role={alert ? 'alert' : undefined}
    >
      <span
        className={cn(
          'inline-flex size-[38px] shrink-0 items-center justify-center rounded-sm bg-surface [&_svg]:size-5 [&_svg]:fill-current',
          toneStyles[tone].icon,
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="min-w-0 text-[0.9rem] text-text-secondary [&>*+*]:mt-2 [&>h3]:m-0 [&>h3]:text-[0.98rem] [&>h3]:text-text [&>p]:m-0 [&>p]:max-w-[640px]">
        {children}
      </div>
    </div>
  )
}
