import type { ReactNode } from 'react'

import { Button } from './Button'

/**
 * "Go back to the previous item" action, whose label includes a paper title of arbitrary
 * length — wraps onto multiple lines instead of clipping it via Button's opt-in `wrap` layout.
 */
export function GoBackButton({ onClick, disabled, children }: {
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Button type="button" variant="secondary" wrap onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  )
}
