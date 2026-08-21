import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, ElementType, ReactNode, Ref } from 'react'

import { cn } from '../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'text' | 'destructive' | 'outline'
export type ButtonSize = 'sm' | 'md'

interface ButtonOwnProps {
  variant?: ButtonVariant
  size?: ButtonSize
  startIcon?: ReactNode
  endIcon?: ReactNode
  iconOnly?: boolean
  loading?: boolean
  disabled?: boolean
  className?: string
  children?: ReactNode
}

/**
 * `as` renders the button's visual chrome on a different element — typically react-router's
 * `Link`, for a same-styled action that navigates instead of handling a click. Defaults to a
 * native `<button>`, matching `ButtonHTMLAttributes` for that case.
 */
export type ButtonProps<C extends ElementType = 'button'> = ButtonOwnProps & { as?: C; ref?: Ref<Element> } & (
  C extends 'button' ? ButtonHTMLAttributes<HTMLButtonElement> : Omit<ComponentPropsWithoutRef<C>, keyof ButtonOwnProps | 'as' | 'ref'>
)

const base =
  'inline-flex items-center justify-center gap-2 rounded-sm text-sm font-semibold leading-none whitespace-nowrap select-none transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 disabled:opacity-[.48] disabled:cursor-not-allowed [&_svg]:shrink-0 [&_svg]:fill-current'

// Icon sizing lives here, one rule per size, rather than a single blanket rule on `base` that
// `iconOnlySizes` would then need to out-rank: Tailwind v4 orders same-property utilities by
// its own internal scale, not by className string order, so two competing `[&_svg]:size-*`
// rules of equal specificity would NOT reliably resolve in the order they're written.
const heights: Record<ButtonSize, string> = {
  md: 'h-10 [&_svg]:size-4',
  sm: 'h-8 text-[13px] [&_svg]:size-4',
}

// Kept separate from `heights` so the `text` variant's narrower padding never has to
// out-rank another px-* utility (same reasoning as the icon-sizing note above).
const paddingX: Record<ButtonSize, string> = {
  md: 'px-4',
  sm: 'px-3',
}

// Icon-only buttons keep the legacy 20px icon size (vs. 16px for a labelled button).
const iconOnlySizes: Record<ButtonSize, string> = {
  md: 'h-10 w-10 min-w-10 px-0 [&_svg]:size-5',
  sm: 'h-8 w-8 min-w-8 px-0 [&_svg]:size-5',
}

// Colors below are the values actually rendered today (verified against a live render of
// the pre-migration CSS), not the later-superseded "final" block of the old stylesheet —
// several legacy selectors (.button-secondary, .link-button, .button-danger) had a second,
// simpler definition further down index.css that won the cascade in practice.
const variants: Record<ButtonVariant, string> = {
  primary:
    'border border-(--button-primary-border) bg-linear-to-b from-(--button-primary-bg-hover) to-(--button-primary-bg) text-(--button-primary-text) shadow-[0_1px_2px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.14)] ' +
    'hover:not-disabled:border-[#a1b0ff] hover:not-disabled:bg-none hover:not-disabled:bg-transparent hover:not-disabled:text-(--button-primary-bg-hover) hover:not-disabled:shadow-[inset_0_0_0_1px_var(--button-primary-border)] ' +
    'active:not-disabled:bg-(--button-primary-bg-active) active:not-disabled:translate-y-px active:not-disabled:shadow-[0_1px_2px_rgba(0,0,0,0.18)]',
  secondary:
    'border border-border bg-surface-raised text-text-secondary ' +
    'hover:not-disabled:border-border-strong hover:not-disabled:bg-surface-hover hover:not-disabled:text-text ' +
    'active:not-disabled:bg-surface-hover active:not-disabled:text-text active:not-disabled:translate-y-px',
  ghost:
    'border border-transparent bg-transparent text-text-secondary ' +
    'hover:not-disabled:border-white/7 hover:not-disabled:bg-surface-hover hover:not-disabled:text-text ' +
    'active:not-disabled:bg-surface-hover active:not-disabled:text-text active:not-disabled:translate-y-px',
  text:
    'border border-transparent bg-transparent text-primary ' +
    'hover:not-disabled:text-primary-strong hover:not-disabled:underline hover:not-disabled:underline-offset-[3px]',
  destructive:
    'border border-[rgba(255,127,130,0.28)] bg-danger-container text-danger ' +
    'hover:not-disabled:border-danger hover:not-disabled:bg-danger-strong hover:not-disabled:text-white ' +
    'active:not-disabled:bg-danger-strong active:not-disabled:text-white active:not-disabled:translate-y-px',
  // The legacy `.icon-button` look: a visible border at rest (unlike `ghost`, which is
  // borderless until hover) over a transparent background. Mainly used for icon-only actions.
  outline:
    'border border-border bg-transparent text-text-secondary ' +
    'hover:not-disabled:border-border-strong hover:not-disabled:bg-surface-hover hover:not-disabled:text-text',
}

const textPaddingX: Record<ButtonSize, string> = {
  md: 'px-1',
  sm: 'px-1',
}

export function Button<C extends ElementType = 'button'>({
  as,
  variant = 'primary',
  size = 'md',
  startIcon,
  endIcon,
  iconOnly = false,
  loading = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps<C>) {
  const Component: ElementType = as ?? 'button'
  return (
    <Component
      {...props}
      className={cn(
        base,
        iconOnly
          ? iconOnlySizes[size]
          : cn(heights[size], variant === 'text' ? textPaddingX[size] : paddingX[size]),
        variants[variant],
        loading && 'relative text-transparent hover:text-transparent',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {startIcon ? <span className="inline-flex shrink-0" aria-hidden="true">{startIcon}</span> : null}
      {loading ? (
        <span
          className="absolute size-4 animate-spin rounded-full border-2 border-current/30 border-t-current text-inherit"
          aria-hidden="true"
        />
      ) : null}
      {children}
      {endIcon ? <span className="inline-flex shrink-0" aria-hidden="true">{endIcon}</span> : null}
    </Component>
  )
}

export function IconButton<C extends ElementType = 'button'>(props: Omit<ButtonProps<C>, 'iconOnly'>) {
  return <Button {...props} iconOnly />
}
