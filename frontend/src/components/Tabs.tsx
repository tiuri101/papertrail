import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '../lib/cn'
import { tabId, tabPanelId } from '../lib/tabs'

export interface TabItem {
  id: string
  label: ReactNode
  danger?: boolean
  disabled?: boolean
  /** Shown as a native tooltip, e.g. explaining why a tab is disabled. */
  title?: string
}

export function TabList({ items, activeId, onSelect, label, idPrefix, className }: {
  items: TabItem[]
  activeId: string
  onSelect: (id: string) => void
  label: string
  /** Derives each tab's id/aria-controls; pass the same prefix to the corresponding <TabPanel>. */
  idPrefix: string
  className?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('inline-flex flex-wrap gap-1.5 rounded-md bg-surface-active p-1.5', className)}
    >
      {items.map((item) => {
        const active = item.id === activeId
        return (
          <button
            key={item.id}
            type="button"
            id={tabId(idPrefix, item.id)}
            role="tab"
            aria-selected={active}
            aria-controls={tabPanelId(idPrefix, item.id)}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onSelect(item.id)}
            className={cn(
              'inline-flex h-auto min-h-10 items-center justify-center gap-2 cursor-pointer rounded-sm border-0 px-5 py-2.5 text-sm font-semibold text-text-secondary disabled:cursor-not-allowed disabled:opacity-[.48] [&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:fill-current',
              !active && 'shadow-none hover:not-disabled:bg-surface-hover hover:not-disabled:text-text',
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

export function TabPanel({ idPrefix, id, className, ...props }: HTMLAttributes<HTMLDivElement> & {
  /** Same prefix passed to <TabList>; combined with `id` to link this panel back to its tab. */
  idPrefix: string
  id: string
}) {
  return (
    <div
      role="tabpanel"
      id={tabPanelId(idPrefix, id)}
      aria-labelledby={tabId(idPrefix, id)}
      className={cn('flex flex-col gap-6', className)}
      {...props}
    />
  )
}
