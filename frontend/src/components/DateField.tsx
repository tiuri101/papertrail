import { useEffect, useId, useRef, useState } from 'react'

import { cn } from '../lib/cn'
import { Button, IconButton } from './Button'
import { Input } from './Input'

interface DateFieldProps {
  id?: string
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  disabled?: boolean
}

interface CalendarCell {
  year: number
  month: number
  day: number
  inMonth: boolean
}

const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month + 1)}-${pad(day)}`
}

function parseIso(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) }
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

// Monday-first weekday index (0 = Monday .. 6 = Sunday)
function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7
}

function buildCalendarDays(year: number, month: number): CalendarCell[] {
  const leading = mondayIndex(new Date(year, month, 1))
  const totalDays = daysInMonth(year, month)
  const cells: CalendarCell[] = []

  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? year - 1 : year
  const prevDays = daysInMonth(prevYear, prevMonth)
  for (let i = leading - 1; i >= 0; i -= 1) {
    cells.push({ year: prevYear, month: prevMonth, day: prevDays - i, inMonth: false })
  }
  for (let day = 1; day <= totalDays; day += 1) {
    cells.push({ year, month, day, inMonth: true })
  }
  const nextMonth = month === 11 ? 0 : month + 1
  const nextYear = month === 11 ? year + 1 : year
  let nextDay = 1
  while (cells.length % 7 !== 0) {
    cells.push({ year: nextYear, month: nextMonth, day: nextDay, inMonth: false })
    nextDay += 1
  }
  return cells
}

export function DateField({ id, label, value, onChange, required, disabled }: DateFieldProps) {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const today = new Date()
  const todayIso = toIso(today.getFullYear(), today.getMonth(), today.getDate())
  const selected = parseIso(value)
  const [view, setView] = useState(() => ({
    year: selected?.year ?? today.getFullYear(),
    month: selected?.month ?? today.getMonth(),
  }))

  useEffect(() => {
    if (!open) return undefined
    setView({ year: selected?.year ?? today.getFullYear(), month: selected?.month ?? today.getMonth() })
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      window.removeEventListener('keydown', closeOnEscape)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const goToPreviousMonth = () => setView((current) => (
    current.month === 0 ? { year: current.year - 1, month: 11 } : { year: current.year, month: current.month - 1 }
  ))
  const goToNextMonth = () => setView((current) => (
    current.month === 11 ? { year: current.year + 1, month: 0 } : { year: current.year, month: current.month + 1 }
  ))

  const cells = buildCalendarDays(view.year, view.month)

  return (
    <div className="relative w-[min(14rem,100%)]" ref={containerRef}>
      <label htmlFor={fieldId}>
        {label}
        <div className="relative">
          <Input
            id={fieldId}
            type="text"
            inputMode="none"
            readOnly
            aria-required={required}
            disabled={disabled}
            value={value}
            placeholder="yyyy-mm-dd"
            className="cursor-pointer pr-11 disabled:cursor-not-allowed"
            onClick={() => !disabled && setOpen((isOpen) => !isOpen)}
            onKeyDown={(event) => {
              if (disabled) return
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
                event.preventDefault()
                setOpen(true)
              }
            }}
          />
          <svg className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 fill-text-secondary" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7Zm12 8v10H5V10h14ZM5 6h14v2H5V6Z" />
          </svg>
        </div>
      </label>
      {open ? (
        <div className="absolute top-[calc(100%+0.5rem)] left-0 z-50 w-[min(300px,88vw)] rounded-md border border-border bg-surface-raised p-4 shadow-lg" role="dialog" aria-label={`${label} calendar`}>
          <div className="mb-3 flex items-center justify-between">
            <IconButton type="button" variant="ghost" size="sm" className="rounded-full" aria-label="Previous month" onClick={goToPreviousMonth}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4 6 12l9 8 1.4-1.4L8.8 12l7.6-6.6Z" /></svg>
            </IconButton>
            <span className="font-semibold text-text">{MONTH_LABELS[view.month]} {view.year}</span>
            <IconButton type="button" variant="ghost" size="sm" className="rounded-full" aria-label="Next month" onClick={goToNextMonth}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 8 5.4 15.6 12 8 18.6 9 20l9-8Z" /></svg>
            </IconButton>
          </div>
          <div className="mb-1 grid grid-cols-7 text-center text-xs font-bold tracking-[0.04em] text-text-muted uppercase">
            {WEEKDAY_LABELS.map((weekday) => <span key={weekday}>{weekday}</span>)}
          </div>
          <div className="grid grid-cols-7" role="grid">
            {cells.map((cell) => {
              const iso = toIso(cell.year, cell.month, cell.day)
              const isSelected = iso === value
              const isToday = iso === todayIso
              return (
                <button
                  type="button"
                  key={iso}
                  className={cn(
                    'min-h-9 w-full cursor-pointer rounded-full border border-transparent bg-none p-0 font-medium text-text transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary',
                    !cell.inMonth && 'text-text-muted',
                    isToday && !isSelected && 'border-primary',
                    isSelected && 'bg-primary text-primary-contrast hover:bg-primary',
                  )}
                  data-in-month={cell.inMonth || undefined}
                  onClick={() => {
                    onChange(iso)
                    setOpen(false)
                  }}
                >
                  {cell.day}
                </button>
              )
            })}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <Button type="button" variant="text" size="sm" onClick={() => { onChange(''); setOpen(false) }}>
              Clear
            </Button>
            <Button
              type="button"
              variant="text"
              size="sm"
              onClick={() => {
                onChange(todayIso)
                setView({ year: today.getFullYear(), month: today.getMonth() })
                setOpen(false)
              }}
            >
              Today
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
