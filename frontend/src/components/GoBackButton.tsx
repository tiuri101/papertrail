import type { ReactNode } from 'react'

/**
 * A secondary button that wraps long text onto multiple lines instead of clipping it — used for
 * "go back to the previous item" actions, whose label includes a paper title of arbitrary length.
 * Not built on <Button>: overriding Button's own `whitespace-nowrap`/fixed height via a trailing
 * className doesn't work (Tailwind v4 doesn't resolve two same-property utilities of equal
 * specificity by className order, and here the base class's utility wins), so this duplicates
 * the `secondary` variant's colors directly rather than fighting them.
 */
export function GoBackButton({ onClick, disabled, children }: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="inline-flex min-h-10 items-center justify-center gap-2 whitespace-normal rounded-sm border border-border bg-surface-raised px-4 py-2 text-center text-sm font-semibold text-text-secondary shadow-none transition-colors duration-150 hover:not-disabled:border-border-strong hover:not-disabled:bg-surface-hover hover:not-disabled:text-text active:not-disabled:bg-surface-hover active:not-disabled:text-text disabled:cursor-not-allowed disabled:opacity-[.48]"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}
