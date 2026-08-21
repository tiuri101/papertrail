import type { ElementType, HTMLAttributes } from 'react'

import { cn } from '../lib/cn'

export interface PageProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType
}

export const pageStyles = 'mx-auto w-[min(1180px,calc(100%_-_40px))] py-10 pb-12 max-[760px]:w-[min(1180px,calc(100%_-_28px))] max-[760px]:pt-8 max-[480px]:w-[min(1180px,calc(100%_-_24px))] max-[480px]:pb-8'

export function Page({ as: Component = 'main', className, ...props }: PageProps) {
  return (
    <Component
      className={cn(pageStyles, className)}
      data-ui="page"
      {...props}
    />
  )
}
