import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ComponentPropsWithoutRef, ElementType, ReactNode, Ref } from 'react'

import { actionListItemClass, type ActionListItemSize } from './actionListStyles'
import { cn } from '../lib/cn'

interface ActionListItemOwnProps {
  size?: ActionListItemSize
  danger?: boolean
  className?: string
  children?: ReactNode
}

/**
 * A row in a quick-actions list or a `RowActionsMenu` dropdown — visually a plain link-like
 * row (icon + label, no border/background/fixed height), not `<Button>`'s chrome. Deliberately
 * not built on `<Button>`: mixes `<a>`/router `Link`/`<button>` items in the same list, and
 * `<Button>`'s own `whitespace-nowrap`/height/justify-center utilities can't be reliably beaten
 * by a trailing className (Tailwind v4 doesn't resolve same-property utility conflicts by
 * source order — see `GoBackButton`'s docstring for the same limitation).
 */
export type ActionListItemProps<C extends ElementType = 'button'> = ActionListItemOwnProps & { as?: C; ref?: Ref<Element> } & (
  C extends 'button' ? ButtonHTMLAttributes<HTMLButtonElement>
    : C extends 'a' ? AnchorHTMLAttributes<HTMLAnchorElement>
      : Omit<ComponentPropsWithoutRef<C>, keyof ActionListItemOwnProps | 'as' | 'ref'>
)

export function ActionListItem<C extends ElementType = 'button'>({
  as,
  size = 'sm',
  danger = false,
  className,
  children,
  ...props
}: ActionListItemProps<C>) {
  const Component: ElementType = as ?? 'button'
  return (
    <Component {...props} className={cn(actionListItemClass({ size, danger }), className)}>
      {children}
    </Component>
  )
}
