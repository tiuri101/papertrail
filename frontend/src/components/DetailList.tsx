import type { HTMLAttributes } from 'react'
import { cn } from '../lib/cn'

export function DetailList({ className, ...props }: HTMLAttributes<HTMLDListElement>) {
  return (
    <dl
      className={cn(
        'm-0 grid grid-cols-[max-content_1fr] gap-x-5 max-[480px]:grid-cols-1 max-[480px]:gap-y-1',
        '[&>dt]:whitespace-nowrap [&>dt]:border-b [&>dt]:border-border [&>dt]:py-2.5 [&>dt]:text-[0.85rem] [&>dt]:font-semibold [&>dt]:text-text-muted',
        '[&>dd]:m-0 [&>dd]:border-b [&>dd]:border-border [&>dd]:py-2.5 [&>dd]:text-text max-[480px]:[&>dd]:pb-3 max-[480px]:[&>dd]:pt-0',
        '[&>dt:last-of-type]:border-b-0 [&>dd:last-of-type]:border-b-0',
        className,
      )}
      {...props}
    />
  )
}

export function DetailListRow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('contents', className)} {...props} />
}
