import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { IconCheckCircle, IconXCircle } from '../../components/icons'
import { formatHotkey, loadScreeningHotkeys, type ScreeningHotkeyAction } from '../../lib/screeningHotkeys'
import type { CriterionAnswer, ScreeningCriterion } from './useScreeningQueue'
import {InfoBox} from "../../components/InfoBox";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const DECISION_OPTIONS: { value: string; label: string; hotkeyAction: ScreeningHotkeyAction }[] = [
  { value: 'include', label: 'Include', hotkeyAction: 'include' },
  { value: 'exclude', label: 'Exclude', hotkeyAction: 'exclude' },
  { value: 'uncertain', label: 'Uncertain', hotkeyAction: 'uncertain' },
  { value: 'duplicate', label: 'Duplicate', hotkeyAction: 'duplicate' },
]

function sortedByKind(criteria: ScreeningCriterion[]): ScreeningCriterion[] {
  return [...criteria].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'inclusion' ? -1 : 1))
}

function criterionNumbers(criteria: ScreeningCriterion[]): Record<string, string> {
  const counts: Record<string, number> = {}
  const numbers: Record<string, string> = {}
  criteria.forEach((criterion) => {
    const prefix = criterion.kind === 'inclusion' ? 'IC' : 'EC'
    const count = (counts[criterion.kind] ?? 0) + 1
    counts[criterion.kind] = count
    numbers[criterion.id] = `${prefix}${count}`
  })
  return numbers
}

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
      <table className="criteria-table">
        <thead>
          <tr>
            <th scope="col">Criterion</th>
            <th scope="col">Fulfilled</th>
            <th scope="col">Not fulfilled</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((criterion, row) => (
            <tr key={criterion.id}>
              <th scope="row">
                <span className={`criterion-badge criterion-badge--${criterion.kind}`}>{numbers[criterion.id]}</span> {criterion.text}
              </th>
              <td>
                <button
                  type="button"
                  role="checkbox"
                  className="criterion-toggle criterion-toggle--fulfilled"
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
                  className="criterion-toggle criterion-toggle--not-fulfilled"
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
          ))}
        </tbody>
      </table>
      <InfoBox icon={<IconCheckCircle />}>
        <p>
          Click on a checkbox, then use the arrow keys to move between criteria and Left/Right keys to answer them. Use your
          personalized hotkeys to include/exclude the paper and submit.
        </p>
      </InfoBox>
      <div className="decision-field">
        <span className="decision-field__label">Decision</span>
        <div className="decision-group" role="radiogroup" aria-label="Decision">
          {DECISION_OPTIONS.map(({ value, label, hotkeyAction }) => {
            const hotkey = formatHotkey(hotkeys[hotkeyAction])
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={outcome === value}
                className={`decision-button decision-button--${value}${outcome === value ? ' decision-button--selected' : ''}`}
                onClick={() => setOutcome(value)}
              >
                {value === 'include' ? <IconCheckCircle /> : value === 'exclude' ? <IconXCircle /> : null}
                {label}
                {hotkey ? <kbd className="decision-button__hotkey" aria-hidden="true">{hotkey}</kbd> : null}
              </button>
            )
          })}
        </div>
      </div>
      <label>
        Notes
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </label>
    </>
  )
}
