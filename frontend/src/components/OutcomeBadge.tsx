import { Badge, type BadgeVariant } from './Badge'
import { IconCheckCircle, IconClock, IconCopy, IconHelpCircle, IconXCircle } from './icons'

const VARIANTS = {
  include: { variant: 'success', Icon: IconCheckCircle },
  exclude: { variant: 'danger', Icon: IconXCircle },
  uncertain: { variant: 'warning', Icon: IconHelpCircle },
  duplicate: { variant: 'neutral', Icon: IconCopy },
  pending: { variant: 'neutral', Icon: IconClock },
} satisfies Record<string, { variant: BadgeVariant; Icon: typeof IconCheckCircle }>

export function OutcomeBadge({ outcome, label }: { outcome: string | null | undefined; label: string }) {
  const { variant, Icon } = VARIANTS[(outcome ?? 'pending') as keyof typeof VARIANTS] ?? VARIANTS.pending

  return (
    <Badge variant={variant}>
      <Icon />
      {label}
    </Badge>
  )
}
