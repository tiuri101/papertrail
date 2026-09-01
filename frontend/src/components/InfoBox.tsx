import type { ReactNode } from 'react'

import { useDismissedInfoBox } from '../hooks/useDismissedInfoBox'
import { cn } from '../lib/cn'
import { IconX } from './icons'

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

type InfoBoxProps = {
  icon: ReactNode
  children: ReactNode
  tone?: keyof typeof toneStyles
  alert?: boolean
  className?: string
} & (
  | { closable: true; id: string }
  | { closable?: false; id?: undefined }
)

export function InfoBox(props: InfoBoxProps) {
  const { icon, children, tone = 'info', alert = false, className, closable = false } = props
  const { dismissed, dismiss } = useDismissedInfoBox(props.closable ? props.id : '')
  if (closable && dismissed) return null

  return (
    <div
      className={cn('relative flex items-center gap-3 rounded-md border p-4', toneStyles[tone].box, className)}
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
      <div
        className={cn(
          'min-w-0 text-[0.9rem] text-text-secondary [&>*+*]:mt-2 [&>h3]:m-0 [&>h3]:text-[0.98rem] [&>h3]:text-text [&>p]:m-0 [&>p]:max-w-[640px]',
          closable && 'pr-6',
        )}
      >
        {children}
      </div>
      {closable ? (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="absolute right-2 top-2 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-surface-hover hover:text-text [&_svg]:size-3 [&_svg]:fill-current"
        >
          <IconX />
        </button>
      ) : null}
    </div>
  )
}
