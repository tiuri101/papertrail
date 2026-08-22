import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'text' | 'destructive'
export type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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
  ref?: Ref<HTMLButtonElement>
}

export function Button({
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
}: ButtonProps) {
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
    <button {...props} className={classes} disabled={disabled || loading} aria-busy={loading || undefined}>
      {startIcon ? <span className="pt-button__icon" aria-hidden="true">{startIcon}</span> : null}
      {loading ? <span className="pt-button__spinner" aria-hidden="true" /> : null}
      {children}
      {endIcon ? <span className="pt-button__icon" aria-hidden="true">{endIcon}</span> : null}
    </button>
  )
}

export function IconButton(props: Omit<ButtonProps, 'iconOnly'>) {
  return <Button {...props} iconOnly />
}
