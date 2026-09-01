import { useState, type FormEvent } from 'react'

import { cn } from '../lib/cn'
import { Button } from './Button'
import { Input } from './Input'
import { toolbarClass } from './layoutStyles'
import { Select } from './Select'

/** Shared "items per page" choices for every paginated table. */
const TABLE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200]

/** Default page size every table starts on (ephemeral — resets on reload). */
export const DEFAULT_TABLE_PAGE_SIZE = 25

interface PaginationSummaryProps {
  /** 1-based page currently shown. */
  page: number
  pageSize: number
  /** Number of rows actually rendered on this page (handles a short last page). */
  itemCount: number
  /** Total rows across every page, after filters. */
  total: number
  /** Singular noun for a row, e.g. "publication". */
  noun: string
  /** Plural form, when it isn't just `noun + 's'`. */
  pluralNoun?: string
  className?: string
}

/**
 * "Showing 26–50 of 240 publications" — the current-slice context line that
 * sits directly above a paginated table. Renders nothing when there are no rows.
 */
export function PaginationSummary({
  page,
  pageSize,
  itemCount,
  total,
  noun,
  pluralNoun,
  className,
}: PaginationSummaryProps) {
  if (total <= 0 || itemCount <= 0) return null

  const start = (page - 1) * pageSize + 1
  const end = Math.min((page - 1) * pageSize + itemCount, total)
  const word = total === 1 ? noun : pluralNoun ?? `${noun}s`

  return (
    <p className={cn('mt-0 mb-3 text-sm text-text-muted', className)} role="status">
      Showing <strong className="text-text-secondary">{start}</strong>–
      <strong className="text-text-secondary">{end}</strong> of{' '}
      <strong className="text-text-secondary">{total}</strong> {word}
    </p>
  )
}

interface PaginationControlsProps {
  /** 1-based current page. */
  page: number
  /** Total number of pages (>= 1). */
  pageCount: number
  pageSize: number
  pageSizeOptions?: number[]
  /** Called with an absolute 1-based page number. Parent owns scroll-to-top. */
  onPageChange: (next: number) => void
  onPageSizeChange: (size: number) => void
  /** Accessible name for the wrapping <nav>, e.g. "Publication pages". */
  label: string
  className?: string
}

/**
 * Table footer: rows-per-page selector (always shown) plus, when there is more
 * than one page, Previous/Next, a "Page X of Y" readout, and a "go to page"
 * box. Purely presentational — page state lives in the parent.
 */
export function PaginationControls({
  page,
  pageCount,
  pageSize,
  pageSizeOptions = TABLE_PAGE_SIZE_OPTIONS,
  onPageChange,
  onPageSizeChange,
  label,
  className,
}: PaginationControlsProps) {
  const [gotoValue, setGotoValue] = useState('')
  const multiPage = pageCount > 1

  const sizeOptions = pageSizeOptions.includes(pageSize)
    ? pageSizeOptions
    : [...pageSizeOptions, pageSize].sort((a, b) => a - b)

  const submitGoto = (event: FormEvent) => {
    event.preventDefault()
    const parsed = Number.parseInt(gotoValue, 10)
    if (Number.isNaN(parsed)) return
    const clamped = Math.min(Math.max(parsed, 1), pageCount)
    setGotoValue('')
    if (clamped !== page) onPageChange(clamped)
  }

  return (
    <nav className={cn(toolbarClass, 'mt-4 items-center', className)} aria-label={label}>
      <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[0.9rem] font-[640] text-text-secondary">
        Rows per page
        <Select
          className="w-[5.5rem]"
          style={{ width: '5.5rem', minWidth: 0 }}
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {sizeOptions.map((size) => (
            <option key={size} value={size}>{size}</option>
          ))}
        </Select>
      </label>

      {multiPage ? (
        <>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <span className="shrink-0 whitespace-nowrap text-text-muted" role="status">
            Page {page} of {pageCount}
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
          <form className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[0.9rem] font-[640] text-text-secondary" onSubmit={submitGoto}>
            <label className="flex items-center gap-2 whitespace-nowrap">
              Go to page
              <Input
                type="number"
                inputMode="numeric"
                className="w-[4.5rem]"
                style={{ width: '4.5rem' }}
                min={1}
                value={gotoValue}
                placeholder={String(page)}
                aria-label="Go to page"
                onChange={(event) => setGotoValue(event.currentTarget.value)}
              />
            </label>
            <Button type="submit" variant="secondary" size="sm" disabled={gotoValue.trim() === ''}>
              Go
            </Button>
          </form>
        </>
      ) : null}
    </nav>
  )
}
