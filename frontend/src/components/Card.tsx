import type { ElementType, HTMLAttributes } from 'react'
import { cn } from '../lib/cn'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Render as a `<section>` where the card is a semantic landmark, not just visual grouping. */
  as?: ElementType
}

/** Tone-agnostic shape/elevation shared with other card-like containers so a differently-toned variant can swap border/background without fighting these utilities for the same properties. */
export const cardShapeStyles = 'relative rounded-lg shadow-sm max-[480px]:rounded-md'
/** Full default-tone visual shell shared with other card-like containers (e.g. CollapsibleSection) so they stay in sync. */
export const cardShellStyles = cn(cardShapeStyles, 'border border-border bg-linear-to-b from-surface-raised to-surface')
/** Responsive outer padding shared with other card-like containers. */
export const cardPaddingStyles = 'p-6 max-[760px]:p-5 max-[480px]:p-4'
/** Gives consecutive first-order cards under a <Page> consistent spacing without each page hand-rolling gaps. */
export const cardPageSiblingSpacingStyles = '[[data-ui=page]_>_[data-ui=card]+&]:mt-6'
const cardChildSpacingStyles = '[&>*+*]:mt-5 [&>h2+*]:mt-4'

export const cardStyles = cn(cardShellStyles, cardPaddingStyles, cardPageSiblingSpacingStyles, cardChildSpacingStyles)

export function Card({ as: Component = 'div', className, ...props }: CardProps) {
  return (
    <Component
      className={cn(
        cardStyles,
        className,
      )}
      data-ui="card"
      {...props}
    />
  )
}
