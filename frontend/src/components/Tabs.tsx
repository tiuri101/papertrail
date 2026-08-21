import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'

export interface TabItem {
  id: string
  label: ReactNode
  danger?: boolean
}

export function TabList({ items, activeId, onSelect, label, className }: {
  items: TabItem[]
  activeId: string
  onSelect: (id: string) => void
  label: string
  className?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('inline-flex flex-wrap gap-1 rounded-md bg-surface-active p-1', className)}
    >
      {items.map((item) => {
        const active = item.id === activeId
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(item.id)}
            className={cn(
              'rounded-sm px-4 py-2 text-[0.88rem] font-semibold text-text-secondary',
              !active && 'hover:bg-surface-hover hover:text-text',
              active && (item.danger ? 'bg-surface text-danger shadow-sm' : 'bg-surface text-primary shadow-sm'),
            )}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export function TabPanel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="tabpanel" className={cn('flex flex-col gap-6', className)} {...props} />
}
