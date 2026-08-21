import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../../lib/cn'
import { ThemeToggle } from '../../components/ThemeToggle'

export const authFormClassName =
  'grid grid-cols-1 gap-5 [&>button:only-of-type]:mt-1 [&>button:only-of-type]:min-h-[46px] [&>button:only-of-type]:w-full'

export const authFieldClassName =
  'grid gap-2 text-sm font-semibold text-text-secondary'

export function AuthPage({ children, showThemeToggle = true, className }: {
  children: ReactNode
  showThemeToggle?: boolean
  className?: string
}) {
  return (
    <main
      className={cn(
        'relative grid min-h-screen place-items-center bg-[radial-gradient(circle_at_18%_12%,var(--color-primary-container-hover),transparent_24rem),radial-gradient(circle_at_82%_82%,var(--color-primary-container),transparent_28rem)] px-4 py-6 sm:px-5 sm:py-8',
        className,
      )}
    >
      {showThemeToggle ? (
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <ThemeToggle />
        </div>
      ) : null}
      {children}
    </main>
  )
}

export function AuthCard({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'w-full max-w-[460px] rounded-lg border border-border bg-[color-mix(in_srgb,var(--color-surface-raised)_94%,transparent)] p-6 shadow-lg backdrop-blur-[18px] sm:rounded-xl sm:p-[clamp(28px,6vw,44px)]',
        className,
      )}
      {...props}
    />
  )
}

export function AuthHeading({ eyebrow, title, titleId, children }: {
  eyebrow?: ReactNode
  title: ReactNode
  titleId: string
  children?: ReactNode
}) {
  return (
    <div className="mb-8">
      {eyebrow ? <p className="mb-1 text-xs font-bold uppercase tracking-[0.08em] text-primary">{eyebrow}</p> : null}
      <h1 id={titleId} className="mb-2 mt-3 text-[clamp(1.75rem,5vw,2.15rem)] font-bold leading-tight">
        {title}
      </h1>
      {children ? <div className="text-text">{children}</div> : null}
    </div>
  )
}

const alertTones = {
  danger: 'border-[rgba(255,127,130,0.28)] bg-danger-container text-danger',
  success: 'border-[rgba(105,217,173,0.35)] bg-success-container text-success',
} as const

export function AuthAlert({ tone = 'danger', className, ...props }: HTMLAttributes<HTMLParagraphElement> & {
  tone?: keyof typeof alertTones
}) {
  return <p className={cn('m-0 rounded-md border p-4', alertTones[tone], className)} {...props} />
}
