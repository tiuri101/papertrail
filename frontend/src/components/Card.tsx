import type { ElementType, HTMLAttributes } from 'react'
import { cn } from '../lib/cn'
import {
  cardStyles,
  cardShapeStyles,
  cardShellStyles,
  cardPaddingStyles,
  cardPageSiblingSpacingStyles,
} from './cardStyles'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Render as a `<section>` where the card is a semantic landmark, not just visual grouping. */
  as?: ElementType
}

// Re-export card styles for backward compatibility with existing imports
// eslint-disable-next-line react-refresh/only-export-components
export { cardShapeStyles, cardShellStyles, cardPaddingStyles, cardPageSiblingSpacingStyles, cardStyles }


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
