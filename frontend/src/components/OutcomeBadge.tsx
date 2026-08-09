import { IconCheckCircle, IconClock, IconCopy, IconHelpCircle, IconXCircle } from './icons'

const VARIANTS = {
  include: { className: 'status-badge--success', Icon: IconCheckCircle },
  exclude: { className: 'status-badge--danger', Icon: IconXCircle },
  uncertain: { className: 'status-badge--warning', Icon: IconHelpCircle },
  duplicate: { className: 'status-badge--neutral', Icon: IconCopy },
  pending: { className: 'status-badge--pending', Icon: IconClock },
} as const

export function OutcomeBadge({ outcome, label }: { outcome: string | null | undefined; label: string }) {
  const variant = VARIANTS[(outcome ?? 'pending') as keyof typeof VARIANTS] ?? VARIANTS.pending
  const { className, Icon } = variant

  return (
    <span className={`status-badge ${className}`}>
      <Icon />
      {label}
    </span>
  )
}
