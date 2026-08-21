import type { AnchorHTMLAttributes, HTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export type BadgeVariant = 'info' | 'primary' | 'success' | 'danger' | 'warning' | 'neutral'

const base =
  'inline-flex min-h-[22px] items-center gap-1 whitespace-nowrap rounded-full py-0.5 pl-[7px] pr-[9px] text-[0.78rem] font-bold [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:fill-current'

const variants: Record<BadgeVariant, string> = {
  info: 'bg-primary text-primary-contrast',
  primary: 'bg-primary-container text-primary',
  success: 'bg-success-container text-success',
  danger: 'bg-danger-container text-danger',
  warning: 'bg-warning-container text-warning',
  neutral: 'bg-surface-hover text-text-secondary',
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export function Badge({ variant = 'neutral', className, ...props }: BadgeProps) {
  return <span className={cn(base, variants[variant], className)} {...props} />
}

export interface BadgeLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: BadgeVariant
}

export function BadgeLink({ variant = 'primary', className, ...props }: BadgeLinkProps) {
  return <a className={cn(base, variants[variant], className)} {...props} />
}
