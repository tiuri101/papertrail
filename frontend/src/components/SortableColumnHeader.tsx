import type { ReactNode } from 'react'

/**
 * A `<th>` for a sortable table column: `aria-sort` lives on the header cell (the correct place
 * per the ARIA table-sort pattern), with a plain button inside toggling the sort. Distinct from
 * `PublicationListSortHeader`, which is a bare button (no `<th>`) for grid-based list layouts
 * that aren't real `<table>`s and so use `aria-pressed` on the button itself instead.
 */
export function SortableColumnHeader({ label, active, direction, onSort, accessory }: {
  label: string
  active: boolean
  direction: 'asc' | 'desc'
  onSort: () => void
  /** Extra content after the button, e.g. an info tooltip explaining the column. */
  accessory?: ReactNode
}) {
  return (
    <th scope="col" aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className="inline-flex min-h-8 items-center gap-1">
        <button
          type="button"
          className="h-auto min-h-0 border-0 bg-transparent p-0 text-text-muted shadow-none hover:not-disabled:bg-transparent hover:not-disabled:text-text"
          onClick={onSort}
        >
          {label}{active ? (direction === 'asc' ? ' ▲' : ' ▼') : ''}
        </button>
        {accessory}
      </span>
    </th>
  )
}
