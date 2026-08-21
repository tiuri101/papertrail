import type { ElementType, HTMLAttributes } from 'react'
import { cn } from '../lib/cn'

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Render as a `<section>` where the card is a semantic landmark, not just visual grouping. */
  as?: ElementType
}

export const cardStyles = 'relative rounded-lg border border-border bg-linear-to-b from-surface-raised to-surface p-6 shadow-sm max-[760px]:p-5 max-[480px]:rounded-md max-[480px]:p-4 [[data-ui=page]_>_[data-ui=card]+&]:mt-6 [&>*+*]:mt-5 [&>h2+*]:mt-4'

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
