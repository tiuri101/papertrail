import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { IconCheckCircle, IconXCircle } from '../../components/icons'
import { formatHotkey, loadScreeningHotkeys, type ScreeningHotkeyAction } from '../../lib/screeningHotkeys'
import { criterionNumbers, sortedByKind } from './criteriaNumbering'
import type { CriterionAnswer, ScreeningCriterion } from './useScreeningQueue'
import {InfoBox} from "../../components/InfoBox";
import { Textarea } from '../../components/Textarea'
import { CriterionBadge } from '../../components/CriterionBadge'

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const DECISION_OPTIONS: { value: string; label: string; hotkeyAction: ScreeningHotkeyAction }[] = [
  { value: 'include', label: 'Include', hotkeyAction: 'include' },
  { value: 'exclude', label: 'Exclude', hotkeyAction: 'exclude' },
  { value: 'uncertain', label: 'Uncertain', hotkeyAction: 'uncertain' },
  { value: 'duplicate', label: 'Duplicate', hotkeyAction: 'duplicate' },
]

type CriterionColumn = 0 | 1

function cellKey(criterionId: string, column: CriterionColumn): string {
  return `${criterionId}:${column}`
}

export function CriteriaAnswerFields({
  criteria,
  answers,
  setAnswers,
  outcome,
  setOutcome,
  notes,
  setNotes,
  autoFocusFirstCriterion = false,
}: {
  criteria: ScreeningCriterion[]
  answers: Record<string, CriterionAnswer>
  setAnswers: (updater: (current: Record<string, CriterionAnswer>) => Record<string, CriterionAnswer>) => void
  outcome: string
  setOutcome: (outcome: string) => void
  notes: string
  setNotes: (notes: string) => void
  autoFocusFirstCriterion?: boolean
}) {
  const numbers = criterionNumbers(criteria)
  const hotkeys = loadScreeningHotkeys()
  const sorted = sortedByKind(criteria)

  const cellRefs = useRef(new Map<string, HTMLButtonElement>())
  const [focusedCell, setFocusedCell] = useState<{ row: number; column: CriterionColumn }>({ row: 0, column: 0 })

  const focusCell = (row: number, column: CriterionColumn) => {
    const criterion = sorted[row]
    if (!criterion) return
    setFocusedCell({ row, column })
    cellRefs.current.get(cellKey(criterion.id, column))?.focus({ preventScroll: true })
  }

  useEffect(() => {
    if (!autoFocusFirstCriterion) return
    const first = sorted[0]
    if (!first) return
    focusCell(0, answers[first.id] === false ? 1 : 0)
    // Only on mount: this fires once when a fresh item's card appears
    // (the parent remounts this component per item via `key`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCellKeyDown = (row: number, column: CriterionColumn) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusCell(Math.min(row + 1, sorted.length - 1), column)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusCell(Math.max(row - 1, 0), column)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const nextColumn: CriterionColumn = column === 0 ? 1 : 0
      const criterion = sorted[row]
      setAnswers((current) => ({ ...current, [criterion.id]: nextColumn === 0 }))
      focusCell(row, nextColumn)
    }
  }

  return (
    <>
      <h3>Criteria</h3>
      <table className="w-full [&_td]:text-center [&_td]:align-middle [&_th]:align-middle [&_th:not(:first-child)]:text-center">
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col">Fulfilled</th>
            <th scope="col">Not fulfilled</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((criterion, row) => {
            // An inclusion criterion being fulfilled is a good sign (keep it green); an exclusion
            // criterion being fulfilled means the exclusion applies, which argues against inclusion
            // (so that's the "bad" red one instead) — the two checkbox columns swap color meaning
            // depending on the criterion's kind, even though "Fulfilled"/"Not fulfilled" stay in the
            // same columns either way.
            const fulfilledColorClasses = criterion.kind === 'exclusion'
              ? 'aria-checked:border-danger aria-checked:bg-danger-container aria-checked:text-danger'
              : 'aria-checked:border-success aria-checked:bg-success-container aria-checked:text-success'
            const notFulfilledColorClasses = criterion.kind === 'exclusion'
              ? 'aria-checked:border-success aria-checked:bg-success-container aria-checked:text-success'
              : 'aria-checked:border-danger aria-checked:bg-danger-container aria-checked:text-danger'
            return (
            <tr key={criterion.id}>
              <th scope="row">
                <CriterionBadge kind={criterion.kind} className="mr-2">{numbers[criterion.id]}</CriterionBadge> {criterion.text}
              </th>
              <td>
                <button
                  type="button"
                  role="checkbox"
                  className={`inline-flex size-8 min-h-8 items-center justify-center rounded-md border border-border bg-none bg-bg-elevated p-0 text-text-muted shadow-none transition-colors hover:border-border-strong hover:bg-surface-hover [&_svg]:size-4 [&_svg]:fill-current ${fulfilledColorClasses}`}
                  aria-checked={answers[criterion.id] === true}
                  aria-label={`${capitalize(criterion.kind)}: ${criterion.text} — Fulfilled`}
                  tabIndex={focusedCell.row === row && focusedCell.column === 0 ? 0 : -1}
                  ref={(el) => {
                    if (el) cellRefs.current.set(cellKey(criterion.id, 0), el)
                    else cellRefs.current.delete(cellKey(criterion.id, 0))
                  }}
                  onFocus={() => setFocusedCell({ row, column: 0 })}
                  onKeyDown={handleCellKeyDown(row, 0)}
                  onClick={() => setAnswers((current) => ({
                    ...current,
                    [criterion.id]: current[criterion.id] === true ? null : true,
                  }))}
                >
                  {answers[criterion.id] === true ? <IconCheckCircle /> : null}
                </button>
              </td>
              <td>
                <button
                  type="button"
                  role="checkbox"
                  className={`inline-flex size-8 min-h-8 items-center justify-center rounded-md border border-border bg-none bg-bg-elevated p-0 text-text-muted shadow-none transition-colors hover:border-border-strong hover:bg-surface-hover [&_svg]:size-4 [&_svg]:fill-current ${notFulfilledColorClasses}`}
                  aria-checked={answers[criterion.id] === false}
                  aria-label={`${capitalize(criterion.kind)}: ${criterion.text} — Not fulfilled`}
                  tabIndex={focusedCell.row === row && focusedCell.column === 1 ? 0 : -1}
                  ref={(el) => {
                    if (el) cellRefs.current.set(cellKey(criterion.id, 1), el)
                    else cellRefs.current.delete(cellKey(criterion.id, 1))
                  }}
                  onFocus={() => setFocusedCell({ row, column: 1 })}
                  onKeyDown={handleCellKeyDown(row, 1)}
                  onClick={() => setAnswers((current) => ({
                    ...current,
                    [criterion.id]: current[criterion.id] === false ? null : false,
                  }))}
                >
                  {answers[criterion.id] === false ? <IconXCircle /> : null}
                </button>
              </td>
            </tr>
            )
          })}
        </tbody>
      </table>
      <InfoBox icon={<IconCheckCircle />} className="hotkey-hint">
        <p>
          Click on a checkbox, then use the arrow keys to move between criteria and Left/Right keys to answer them. Use your
          personalized hotkeys to include/exclude the paper and submit.
        </p>
      </InfoBox>
      <div className="@container grid gap-2">
        <span className="text-sm font-semibold text-text-secondary">Decision</span>
        {/*
          A container query (keyed to this row's own available width) rather than a viewport
          media query: the identical decision grid is embedded both in the full-width live
          screening queue and in narrower contexts (e.g. revising a past decision inline in a
          list item on My Decisions), and a viewport breakpoint made the buttons collapse to a
          cramped 2-column layout in the narrower context even on a wide screen, since the
          viewport itself was plenty wide — only the local container wasn't.
        */}
        <div className="grid grid-cols-2 gap-2 @[520px]:grid-cols-4" role="radiogroup" aria-label="Decision">
          {DECISION_OPTIONS.map(({ value, label, hotkeyAction }) => {
            const hotkey = formatHotkey(hotkeys[hotkeyAction])
            const selected = outcome === value
            const selectedClasses = {
              include: 'border-success bg-success-container text-success',
              exclude: 'border-danger bg-danger-container text-danger',
              uncertain: 'border-warning bg-warning-container text-warning',
              duplicate: 'border-border-strong bg-surface-hover text-text',
            }[value]
            const hoverClasses = {
              include: 'hover:border-success/50 hover:bg-success-container hover:text-success',
              exclude: 'hover:border-danger/50 hover:bg-danger-container hover:text-danger',
              uncertain: 'hover:border-warning/50 hover:bg-warning-container hover:text-warning',
              duplicate: 'hover:border-border-strong hover:bg-surface-hover hover:text-text',
            }[value]
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={outcome === value}
                className={`relative inline-flex min-h-10 items-center justify-center gap-2 rounded-md border bg-none px-3 py-2 text-sm font-semibold transition-colors [&_svg]:size-4 [&_svg]:fill-current ${selected ? selectedClasses : `border-border bg-surface-raised text-text-secondary ${hoverClasses}`}`}
                onClick={() => setOutcome(value)}
              >
                {value === 'include' ? <IconCheckCircle /> : value === 'exclude' ? <IconXCircle /> : null}
                {label}
                {hotkey ? <kbd className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 py-0.5 text-[0.65rem] ${selected ? 'bg-white/15 text-current' : 'bg-surface-active text-text-muted'}`} aria-hidden="true">{hotkey}</kbd> : null}
              </button>
            )
          })}
        </div>
      </div>
      <label>
        Notes
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
    </>
  )
}
