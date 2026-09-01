import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { Button } from '../../components/Button'
import { IconCheckCircle, IconSparkle, IconXCircle } from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'
import { useUiPreference } from '../../hooks/useUiPreferences'
import { cn } from '../../lib/cn'
import {
  DEFAULT_SCREENING_HOTKEYS,
  formatHotkey,
  SCREENING_HOTKEYS_PREFERENCE_KEY,
  type ScreeningHotkeyAction,
  type ScreeningHotkeys,
} from '../../lib/screeningHotkeys'
import { criterionNumbers, sortedByKind } from './criteriaNumbering'
import { tableBaseClass } from '../../components/layoutStyles'
import type { CriterionAnswer, ScreeningCriterion } from './useScreeningQueue'
import {InfoBox} from "../../components/InfoBox";
import { Textarea } from '../../components/Textarea'
import { CriterionBadge } from '../../components/CriterionBadge'
import { FieldLabel } from '../../components/FieldLabel'
import {
  criterionComparison,
  LlmEvidence,
  statusText,
  type CriterionSuggestion,
  type ScreeningAssistance,
} from '../llm/LlmTaskComponents'

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Matches the max-[760px] breakpoint used elsewhere in this file to identify the mobile layout.
const MOBILE_MEDIA_QUERY = '(max-width: 760px)'

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

function rowToneClass(comparison: 'match' | 'mismatch' | null): string {
  return cn(
    comparison === 'match' && 'bg-success-container! hover:bg-success-container!',
    comparison === 'mismatch' && 'bg-danger-container! hover:bg-danger-container!',
  )
}

export interface CriteriaLlmAssistance {
  /** The same query result driving `ScreeningLlmPanel` — pass it through unchanged. */
  data: ScreeningAssistance | undefined
  stage: 'title_abstract' | 'full_text'
  projectId: string
  publicationId: string
  onApplySuggestion?: (criterionId: string, met: boolean) => void
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
  llm,
}: {
  criteria: ScreeningCriterion[]
  answers: Record<string, CriterionAnswer>
  setAnswers: (updater: (current: Record<string, CriterionAnswer>) => Record<string, CriterionAnswer>) => void
  outcome: string
  setOutcome: (outcome: string) => void
  notes: string
  setNotes: (notes: string) => void
  autoFocusFirstCriterion?: boolean
  /**
   * Optional LLM suggestion context. Until `llm.data` reaches the `ready`
   * state (hidden before the reviewer's own decision, still processing,
   * etc.), the table renders exactly as it does without this prop at all —
   * no coloring, no click-to-expand. Once ready, rows compare the model's
   * per-criterion assessment against the reviewer's own answer.
   */
  llm?: CriteriaLlmAssistance
}) {
  const numbers = criterionNumbers(criteria)
  const { value: hotkeys } = useUiPreference<ScreeningHotkeys>(SCREENING_HOTKEYS_PREFERENCE_KEY, DEFAULT_SCREENING_HOTKEYS)
  const sorted = sortedByKind(criteria)

  const cellRefs = useRef(new Map<string, HTMLButtonElement>())
  const [focusedCell, setFocusedCell] = useState<{ row: number; column: CriterionColumn }>({ row: 0, column: 0 })
  const [expandedCriterionId, setExpandedCriterionId] = useState<string | null>(null)

  const suggestionByCriterion = useMemo(() => {
    const map: Record<string, CriterionSuggestion> = {}
    if (llm?.data?.state === 'ready' && !llm.data.hidden) {
      for (const suggestion of llm.data.criteria) {
        if (suggestion.criterionId) map[suggestion.criterionId] = suggestion
      }
    }
    return map
  }, [llm?.data])

  useEffect(() => {
    // Collapse any expanded explanation when the suggestion set changes
    // (e.g. a fresh item loads, or the suggestion is regenerated).
    setExpandedCriterionId(null)
  }, [suggestionByCriterion])

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
      <div className="[&>*+*]:mt-2">
        <h3>Criteria</h3>
        <table className={`${tableBaseClass} w-full [&_th]:align-middle! [&_th:nth-child(n+3)]:text-center!`}>
          <thead>
            <tr>
              <th scope="col" className="sr-only">Kind</th>
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
              const suggestion = suggestionByCriterion[criterion.id]
              const comparison = suggestion ? criterionComparison(suggestion.assessment, answers[criterion.id]) : null
              const isExpanded = suggestion !== undefined && expandedCriterionId === criterion.id
              const toggleExpanded = () => {
                if (!suggestion) return
                setExpandedCriterionId((current) => current === criterion.id ? null : criterion.id)
              }
              return (
                <Fragment key={criterion.id}>
                  <tr
                    className={cn(rowToneClass(comparison), suggestion && 'cursor-pointer')}
                    onClick={suggestion ? toggleExpanded : undefined}
                    onKeyDown={suggestion ? (event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      toggleExpanded()
                    } : undefined}
                    tabIndex={suggestion ? 0 : undefined}
                    aria-expanded={suggestion ? isExpanded : undefined}
                  >
                    <td className={cn('whitespace-nowrap text-center! align-middle!', isExpanded && 'border-b-0!')}>
                      <CriterionBadge kind={criterion.kind}>{numbers[criterion.id]}</CriterionBadge>
                    </td>
                    <th
                      scope="row"
                      className={cn('max-[760px]:cursor-pointer max-[760px]:active:bg-surface-hover', isExpanded && 'border-b-0!')}
                      onClick={(event) => {
                        // On mobile the checkboxes are small tap targets, so tapping the criterion
                        // text itself toggles fulfilled/not-fulfilled instead. Desktop pointers keep
                        // using the checkboxes, so this is a no-op outside the mobile breakpoint.
                        if (!window.matchMedia(MOBILE_MEDIA_QUERY).matches) return
                        event.stopPropagation()
                        setAnswers((current) => ({
                          ...current,
                          [criterion.id]: current[criterion.id] === true ? false : true,
                        }))
                      }}
                    >
                      {criterion.text}
                      {suggestion ? (
                        <span
                          className="ml-1.5 inline-flex align-text-top text-primary [&_svg]:size-3.5 [&_svg]:fill-current"
                          aria-hidden="true"
                          title="LLM suggestion available — click the row to view it"
                        >
                          <IconSparkle />
                        </span>
                      ) : null}
                    </th>
                    <td className={cn('text-center! align-middle!', isExpanded && 'border-b-0!')}>
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
                        onClick={(event) => {
                          event.stopPropagation()
                          setAnswers((current) => ({
                            ...current,
                            [criterion.id]: current[criterion.id] === true ? false : true,
                          }))
                        }}
                      >
                        {answers[criterion.id] === true ? <IconCheckCircle /> : null}
                      </button>
                    </td>
                    <td className={cn('text-center! align-middle!', isExpanded && 'border-b-0!')}>
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
                        onClick={(event) => {
                          event.stopPropagation()
                          setAnswers((current) => ({
                            ...current,
                            [criterion.id]: current[criterion.id] === false ? true : false,
                          }))
                        }}
                      >
                        {answers[criterion.id] === false ? <IconXCircle /> : null}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && suggestion && llm ? (
                    <tr className={rowToneClass(comparison)} aria-label={`LLM suggestion for ${criterion.text}`}>
                      {/*
                        `w-px` keeps this cell's (unwrapped-word) content from
                        forcing the table's auto layout to widen every column
                        to fit it -- without it, expanding a row nudges the
                        whole table (badge width, header position, everything)
                        a few pixels wider than the collapsed layout.
                      */}
                      <td colSpan={4} className="w-px">
                        <p>
                          <strong>LLM assessment:</strong> {statusText(suggestion.assessment)}
                          {comparison === 'mismatch' ? (
                            <span className="ml-2 font-semibold text-danger">⚠ Differs from your answer</span>
                          ) : null}
                        </p>
                        <p>{suggestion.explanation}</p>
                        {llm.stage === 'full_text' ? (
                          <LlmEvidence
                            evidence={suggestion.evidence}
                            projectId={llm.projectId}
                            publicationId={llm.publicationId}
                          />
                        ) : null}
                        {comparison === 'mismatch' && llm.onApplySuggestion ? (
                          <div className={toolbarClass}>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={(event) => {
                                event.stopPropagation()
                                llm.onApplySuggestion!(criterion.id, suggestion.assessment === 'met')
                              }}
                            >
                              Apply suggestion
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {Object.keys(suggestionByCriterion).length > 0 ? (
        <p className="text-sm text-text-muted">
          Rows are colored by how the LLM suggestion compares to your answer — click a row to see its explanation.
        </p>
      ) : null}
      <InfoBox icon={<IconCheckCircle />} className="hotkey-hint mb-4 max-[760px]:hidden">
        <p>
          Click on a checkbox, then use the arrow keys to move between criteria and Left/Right keys to answer them. Use your
          personalized hotkeys to include/exclude the paper and submit.
        </p>
      </InfoBox>
      <div className="@container grid gap-2 mb-4">
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
                className={`relative inline-flex min-h-10 w-45 items-center justify-center gap-2 rounded-md border bg-none px-3 py-2 text-sm font-semibold transition-colors [&_svg]:size-4 [&_svg]:fill-current ${selected ? selectedClasses : `border-border bg-surface-raised text-text-secondary ${hoverClasses}`}`}
                onClick={() => setOutcome(value)}
              >
                {value === 'include' ? <IconCheckCircle /> : value === 'exclude' ? <IconXCircle /> : null}
                {label}
                {hotkey ? <kbd className={`absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-[20px] min-w-[20px] items-center justify-center rounded border border-border-strong px-1 py-0.5 text-[0.65rem] leading-none font-bold opacity-[0.85] [font-family:inherit] ${selected ? 'bg-white/15 text-current' : 'bg-surface-active text-text-muted'}`} aria-hidden="true">{hotkey}</kbd> : null}
              </button>
            )
          })}
        </div>
      </div>
      <FieldLabel>
        Notes
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </FieldLabel>
    </>
  )
}
