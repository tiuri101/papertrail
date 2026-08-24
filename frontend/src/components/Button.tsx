import type { ComponentPropsWithRef, ElementType, ReactNode } from 'react'

import { cn } from '../lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'text' | 'destructive'
export type ButtonSize = 'sm' | 'md'

interface ButtonOwnProps {
  variant?: ButtonVariant
  size?: ButtonSize
  startIcon?: ReactNode
  endIcon?: ReactNode
  iconOnly?: boolean
  loading?: boolean
  /**
   * Opt-in auto-height layout: wraps long label text onto multiple lines instead of clipping it,
   * for actions like "go back to <arbitrary-length title>". Off by default — every other Button
   * usage keeps the fixed single-line height.
   */
  wrap?: boolean
  children?: ReactNode
}

export type ButtonProps<T extends ElementType = 'button'> = ButtonOwnProps & {
  /** Render as a different element/component (e.g. `as={Link}` for an in-app navigation button). */
  as?: T
} & Omit<ComponentPropsWithRef<T>, keyof ButtonOwnProps | 'as'>

const baseClass = [
  'inline-flex h-10 min-h-10 items-center justify-center gap-2 rounded-sm border border-transparent px-4',
  'text-sm font-semibold leading-none whitespace-nowrap no-underline select-none',
  'transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150',
  'focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--button-focus)]',
  'disabled:cursor-not-allowed disabled:opacity-[var(--button-disabled-opacity)] disabled:transform-none disabled:shadow-none',
  '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:fill-current',
].join(' ')

const variantClasses: Record<ButtonVariant, string> = {
  primary: [
    'border-[var(--button-primary-border)] bg-primary text-primary-contrast',
    'shadow-[0_1px_2px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.14)]',
    'hover:not-disabled:border-[#a1b0ff] hover:not-disabled:bg-transparent hover:not-disabled:text-[var(--button-primary-bg-hover)]',
    'hover:not-disabled:shadow-[inset_0_0_0_1px_var(--button-primary-border)]',
    'active:not-disabled:translate-y-px active:not-disabled:bg-[var(--button-primary-bg-active)]',
    'active:not-disabled:shadow-[0_1px_2px_rgba(0,0,0,0.18)]',
  ].join(' '),
  secondary: [
    'border-border bg-surface-raised text-text-secondary shadow-none',
    'hover:not-disabled:border-border-strong hover:not-disabled:bg-surface-hover hover:not-disabled:text-text',
    'active:not-disabled:translate-y-px active:not-disabled:bg-[var(--button-secondary-bg-active)]',
  ].join(' '),
  ghost: [
    'border-transparent bg-transparent text-text-secondary shadow-none',
    'hover:not-disabled:border-transparent hover:not-disabled:bg-surface-hover hover:not-disabled:text-text',
    'active:not-disabled:translate-y-px active:not-disabled:bg-[var(--button-ghost-bg-active)]',
  ].join(' '),
  text: [
    'border-transparent bg-transparent px-1 text-primary shadow-none',
    'hover:not-disabled:bg-transparent hover:not-disabled:text-primary-strong hover:not-disabled:underline hover:not-disabled:underline-offset-3',
  ].join(' '),
  destructive: [
    'border-[rgba(255,127,130,0.28)] bg-danger-container text-danger shadow-none',
    'hover:not-disabled:border-danger hover:not-disabled:bg-danger-strong hover:not-disabled:text-white',
    'active:not-disabled:translate-y-px active:not-disabled:bg-[var(--button-danger-bg-active)]',
  ].join(' '),
}

const iconOnlyClass = [
  'border-border bg-[var(--button-secondary-bg)] text-[var(--button-secondary-text)] shadow-none',
  'hover:not-disabled:border-border-strong hover:not-disabled:bg-surface-hover hover:not-disabled:text-text',
].join(' ')

const sizeClasses: Record<ButtonSize, string> = {
  md: '',
  sm: 'h-8 min-h-8 px-2.5 py-[5px] text-[0.82rem]',
}

const iconOnlySizeClasses: Record<ButtonSize, string> = {
  md: 'size-10 min-h-10 min-w-10 p-0',
  sm: 'size-8 min-h-8 min-w-8 p-0',
}

export function Button<T extends ElementType = 'button'>({
  as,
  variant = 'primary',
  size = 'md',
  startIcon,
  endIcon,
  iconOnly = false,
  loading = false,
  wrap = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps<T>) {
  const Component: ElementType = as ?? 'button'

  return (
    <Component
      {...props}
      className={cn(
        baseClass,
        iconOnly ? iconOnlyClass : variantClasses[variant],
        iconOnly ? iconOnlySizeClasses[size] : sizeClasses[size],
        wrap && 'h-auto min-h-10 py-2 whitespace-normal text-center',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {startIcon ? <span className="inline-flex" aria-hidden="true">{startIcon}</span> : null}
      {loading ? (
        <span
          className="size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent"
          aria-hidden="true"
        />
      ) : null}
      {children}
      {endIcon ? <span className="inline-flex" aria-hidden="true">{endIcon}</span> : null}
    </Component>
  )
}

export function IconButton<T extends ElementType = 'button'>(props: Omit<ButtonProps<T>, 'iconOnly'>) {
  return <Button {...props as ButtonProps<T>} iconOnly />
}
