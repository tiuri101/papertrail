import { useMemo, useState } from 'react'

import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { CountPill } from '../../components/CountPill'
import { LlmEvidence } from '../llm/LlmTaskComponents'
import {
  useEvidenceCellDetail,
  useEvidenceMatrix,
  type EvidenceFilterPredicate,
  type EvidenceMatrixColumn,
  type EvidenceMatrixItem,
  type EvidenceState,
} from './useEvidenceMatrix'

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

const STATE_LABELS: Record<EvidenceState, string> = {
  answered: 'Answered',
  missing: 'Missing',
  pending_reconciliation: 'Pending reconciliation',
}

const RESOLUTION_METHOD_LABELS: Record<string, string> = {
  single_reviewer: 'Single review',
  agreement: 'Reviewer agreement',
  reconciliation: 'Reconciled',
  override: 'Manager override',
}

function resolutionMethodLabel(method: string | null): string {
  if (!method) return '—'
  return RESOLUTION_METHOD_LABELS[method] ?? method
}

function formatCellValue(value: unknown, fieldType: string): string {
  if (value === null || value === undefined || value === '') return '—'
  if (fieldType === 'checkbox') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  return String(value)
}

function isNumericFieldType(fieldType: string): boolean {
  return fieldType === 'number' || fieldType === 'rating'
}

function isMultiSelectFieldType(fieldType: string): boolean {
  return fieldType === 'multiple_select'
}

function isCategoricalFieldType(fieldType: string): boolean {
  return fieldType === 'single_select'
}

type FilterMode = 'none' | 'missing' | 'pending_reconciliation' | 'value'

function filterModeFor(predicate: EvidenceFilterPredicate | undefined): FilterMode {
  if (!predicate) return 'none'
  if (predicate.type === 'presence') {
    return predicate.state === 'answered' ? 'none' : predicate.state
  }
  return 'value'
}

function ColumnFilterControl({
  column,
  predicate,
  onChange,
}: {
  column: EvidenceMatrixColumn
  predicate: EvidenceFilterPredicate | undefined
  onChange: (next: EvidenceFilterPredicate | undefined) => void
}) {
  const mode = filterModeFor(predicate)
  const options = column.options?.map((option) => String(option)) ?? []

  const setMode = (nextMode: FilterMode) => {
    if (nextMode === 'none') {
      onChange(undefined)
    } else if (nextMode === 'missing' || nextMode === 'pending_reconciliation') {
      onChange({ type: 'presence', state: nextMode })
    } else if (isCategoricalFieldType(column.fieldType)) {
      onChange({ type: 'categorical', values: [] })
    } else if (isMultiSelectFieldType(column.fieldType)) {
      onChange({ type: 'multi_select', anyOf: [] })
    } else if (isNumericFieldType(column.fieldType)) {
      onChange({ type: 'numeric' })
    } else {
      onChange({ type: 'text', contains: '' })
    }
  }

  return (
    <div className="evidence-matrix__filter">
      <label>
        <span className="visually-hidden">Filter {column.label}</span>
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as FilterMode)}
          aria-label={`Filter ${column.label}`}
        >
          <option value="none">No filter</option>
          <option value="value">Filter by value…</option>
          <option value="missing">Only missing</option>
          <option value="pending_reconciliation">Only pending reconciliation</option>
        </select>
      </label>
      {mode === 'value' && predicate?.type === 'categorical' ? (
        <select
          multiple
          aria-label={`${column.label} values`}
          value={predicate.values}
          onChange={(event) => {
            const selected = Array.from(event.target.selectedOptions, (option) => option.value)
            onChange({ type: 'categorical', values: selected })
          }}
        >
          {options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : null}
      {mode === 'value' && predicate?.type === 'multi_select' ? (
        <fieldset className="evidence-matrix__filter-checkboxes">
          <legend className="visually-hidden">{column.label} values</legend>
          {options.map((option) => {
            const checked = predicate.anyOf.includes(option)
            return (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...predicate.anyOf, option]
                      : predicate.anyOf.filter((item) => item !== option)
                    onChange({ type: 'multi_select', anyOf: next })
                  }}
                />
                {option}
              </label>
            )
          })}
        </fieldset>
      ) : null}
      {mode === 'value' && predicate?.type === 'numeric' ? (
        <span className="evidence-matrix__filter-range">
          <input
            type="number"
            aria-label={`${column.label} minimum`}
            placeholder="Min"
            value={predicate.min ?? ''}
            onChange={(event) => onChange({
              ...predicate,
              min: event.target.value === '' ? undefined : Number(event.target.value),
            })}
          />
          <input
            type="number"
            aria-label={`${column.label} maximum`}
            placeholder="Max"
            value={predicate.max ?? ''}
            onChange={(event) => onChange({
              ...predicate,
              max: event.target.value === '' ? undefined : Number(event.target.value),
            })}
          />
        </span>
      ) : null}
      {mode === 'value' && predicate?.type === 'text' ? (
        <input
          type="text"
          aria-label={`${column.label} contains`}
          placeholder="Contains…"
          value={predicate.contains}
          onChange={(event) => onChange({ type: 'text', contains: event.target.value })}
        />
      ) : null}
    </div>
  )
}

interface CellSelection {
  publicationId: string
  publicationTitle: string
  sourceType: 'extraction' | 'quality'
  fieldKey: string
}

function CellDetailPanel({
  projectId,
  selection,
  onClose,
}: {
  projectId: string
  selection: CellSelection
  onClose: () => void
}) {
  const query = useEvidenceCellDetail(projectId, {
    publicationId: selection.publicationId,
    sourceType: selection.sourceType,
    fieldKey: selection.fieldKey,
  })
  const detail = query.data

  return (
    <aside className="evidence-matrix__detail nested-card" aria-label="Field evidence detail">
      <div className="toolbar">
        <h3>{selection.publicationTitle}</h3>
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
      </div>
      {query.isLoading ? <p>Loading…</p> : null}
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {detail ? (
        <>
          <p className="muted">
            {detail.label} · {detail.sourceType === 'quality' ? 'Quality assessment' : 'Extraction'}
          </p>
          <dl className="evidence-matrix__detail-meta">
            <div>
              <dt>Value</dt>
              <dd>{formatCellValue(detail.value, detail.fieldType)}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>{STATE_LABELS[detail.state]}</dd>
            </div>
            <div>
              <dt>Resolution</dt>
              <dd>{resolutionMethodLabel(detail.resolutionMethod)}</dd>
            </div>
            {detail.resolvedAt ? (
              <div>
                <dt>Resolved</dt>
                <dd>{new Date(detail.resolvedAt).toLocaleString()}</dd>
              </div>
            ) : null}
          </dl>
          {detail.state === 'answered' ? (
            detail.evidence.length ? (
              <LlmEvidence
                evidence={detail.evidence}
                projectId={projectId}
                publicationId={selection.publicationId}
              />
            ) : (
              <p className="muted">No traceable source quotation for this value.</p>
            )
          ) : null}
        </>
      ) : null}
    </aside>
  )
}

export function EvidenceMatrixSection({ projectId }: { projectId: string }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [filters, setFilters] = useState<Record<string, EvidenceFilterPredicate>>({})
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<CellSelection | null>(null)

  const query = useEvidenceMatrix(projectId, { search, filters, page, pageSize })
  const data = query.data

  const visibleColumns = useMemo(
    () => (data?.columns ?? []).filter((column) => !hiddenColumns.has(column.key)),
    [data?.columns, hiddenColumns],
  )

  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  const setFilter = (key: string, predicate: EvidenceFilterPredicate | undefined) => {
    setPage(1)
    setFilters((current) => {
      const next = { ...current }
      if (predicate === undefined) {
        delete next[key]
      } else {
        next[key] = predicate
      }
      return next
    })
  }

  const toggleColumn = (key: string) => {
    setHiddenColumns((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Card as="section" id="section-analysis-evidence-matrix">
      <h2>Evidence Matrix</h2>
      <p className="muted">
        Every included publication against every extraction and quality field, with the
        authoritative value and, where traceable, the source quotation behind it. A value
        marked <span aria-hidden="true">✦</span> has a traceable source quotation — click it to view the evidence.
      </p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      <div className="toolbar">
        <label>
          Search
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            placeholder="Filter by title, author, or any answer…"
          />
        </label>
        <label>
          Rows per page
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value))
              setPage(1)
            }}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
      </div>
      {data ? (
        <details className="evidence-matrix__columns">
          <summary>Show/hide columns ({visibleColumns.length} of {data.columns.length} shown)</summary>
          <div className="evidence-matrix__column-toggle-list">
            {data.columns.map((column) => (
              <label key={column.key}>
                <input
                  type="checkbox"
                  checked={!hiddenColumns.has(column.key)}
                  onChange={() => toggleColumn(column.key)}
                />
                {column.label}
              </label>
            ))}
          </div>
        </details>
      ) : null}
      {data ? (
        <CountPill count={data.total}>publication{data.total === 1 ? '' : 's'}</CountPill>
      ) : null}
      {data && data.items.length === 0 ? <p>No publications match your search and filters.</p> : null}
      {data && data.items.length > 0 ? (
        <div className="evidence-matrix__scroll">
          <table className="evidence-matrix__table">
            <thead>
              <tr>
                <th scope="col" className="evidence-matrix__sticky-col">Publication</th>
                {visibleColumns.map((column) => (
                  <th scope="col" key={column.key}>
                    {column.label}
                    <ColumnFilterControl
                      column={column}
                      predicate={filters[column.key]}
                      onChange={(predicate) => setFilter(column.key, predicate)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((item: EvidenceMatrixItem) => (
                <tr key={item.publication.id}>
                  <th scope="row" className="evidence-matrix__sticky-col">
                    {item.publication.title}
                    {item.publication.authors ? (
                      <span className="muted"> · {item.publication.authors}</span>
                    ) : null}
                  </th>
                  {visibleColumns.map((column) => {
                    const cell = item.cells[column.key]
                    const state = cell?.state ?? 'missing'
                    const clickable = state !== 'missing'
                    return (
                      <td
                        key={column.key}
                        className={`evidence-matrix__cell evidence-matrix__cell--${state}`}
                      >
                        {clickable ? (
                          <Button
                            type="button"
                            variant="text"
                            onClick={() => setSelection({
                              publicationId: item.publication.id,
                              publicationTitle: item.publication.title,
                              sourceType: column.source,
                              fieldKey: column.key.split(':').slice(1).join(':'),
                            })}
                          >
                            {state === 'pending_reconciliation'
                              ? 'Pending reconciliation'
                              : formatCellValue(cell?.value, column.fieldType)}
                            {cell?.hasEvidence ? (
                              <span aria-hidden="true" title="Has a traceable source quotation"> ✦</span>
                            ) : null}
                          </Button>
                        ) : (
                          '—'
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data && pageCount > 1 ? (
        <div className="toolbar">
          <Button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>
            Previous
          </Button>
          <span>Page {page} of {pageCount}</span>
          <Button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount}>
            Next
          </Button>
        </div>
      ) : null}
      {selection ? (
        <CellDetailPanel projectId={projectId} selection={selection} onClose={() => setSelection(null)} />
      ) : null}
    </Card>
  )
}
