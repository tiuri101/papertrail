import type { ComponentPropsWithRef, ElementType, ReactNode } from 'react'

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
  const classes = [
    'pt-button',
    `pt-button--${variant}`,
    `pt-button--${size}`,
    iconOnly ? 'pt-button--icon-only' : '',
    loading ? 'pt-button--loading' : '',
    wrap ? 'pt-button--wrap' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <Component {...props} className={classes} disabled={disabled || loading} aria-busy={loading || undefined}>
      {startIcon ? <span className="pt-button__icon" aria-hidden="true">{startIcon}</span> : null}
      {loading ? <span className="pt-button__spinner" aria-hidden="true" /> : null}
      {children}
      {endIcon ? <span className="pt-button__icon" aria-hidden="true">{endIcon}</span> : null}
    </Component>
  )
}

export function IconButton<T extends ElementType = 'button'>(props: Omit<ButtonProps<T>, 'iconOnly'>) {
  return <Button {...props as ButtonProps<T>} iconOnly />
}
