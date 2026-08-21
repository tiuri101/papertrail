import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CountPill } from '../../components/CountPill'
import { StageEyebrow } from '../projects/StageEyebrow'

interface FieldMeta {
  stableKey: string
  label: string
  fieldType: string
}

interface StageResult {
  status: string
  completedAt: string | null
  reviewerName: string | null
  answers: Record<string, unknown>
}

interface QualityResult extends StageResult {
  totalScore: number | null
}

interface FinalResultPublication {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  venue: string | null
  publicationType: string | null
  doi: string | null
  publisherUrl: string | null
  keywords: string | null
}

interface FinalResultItem {
  publication: FinalResultPublication
  extraction: StageResult | null
  quality: QualityResult | null
}

export interface FinalResultsResponse {
  qualityEnabled: boolean
  extractionFields: FieldMeta[]
  qualityFields: FieldMeta[]
  items: FinalResultItem[]
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

type SortDirection = 'asc' | 'desc'

interface Column {
  key: string
  label: string
  getValue: (item: FinalResultItem) => string | number | null
  render?: (item: FinalResultItem) => ReactNode
}

function formatAnswer(value: unknown, fieldType: string): string {
  if (value === null || value === undefined || value === '') return '—'
  if (fieldType === 'checkbox') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  return String(value)
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : '—'
}

function statusLabel(status: string | undefined): string {
  if (!status) return 'Not started'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function buildColumns(data: FinalResultsResponse): Column[] {
  const columns: Column[] = [
    { key: 'title', label: 'Title', getValue: (item) => item.publication.title },
    { key: 'authors', label: 'Authors', getValue: (item) => item.publication.authors ?? '—' },
    { key: 'year', label: 'Year', getValue: (item) => item.publication.publicationYear },
    { key: 'venue', label: 'Venue', getValue: (item) => item.publication.venue ?? '—' },
    {
      key: 'doi',
      label: 'DOI',
      getValue: (item) => item.publication.doi ?? '—',
      render: (item) => (
        item.publication.doi ? (
          <a href={`https://doi.org/${item.publication.doi}`} target="_blank" rel="noopener noreferrer">
            {item.publication.doi}
          </a>
        ) : '—'
      ),
    },
    {
      key: 'extraction_status',
      label: 'Extraction Status',
      getValue: (item) => statusLabel(item.extraction?.status),
    },
    {
      key: 'extraction_reviewer',
      label: 'Extracted By',
      getValue: (item) => item.extraction?.reviewerName ?? '—',
    },
    {
      key: 'extraction_completed_at',
      label: 'Extraction Completed',
      getValue: (item) => item.extraction?.completedAt ?? null,
      render: (item) => formatDate(item.extraction?.completedAt ?? null),
    },
  ]

  for (const field of data.extractionFields) {
    columns.push({
      key: `extraction:${field.stableKey}`,
      label: field.label,
      getValue: (item) => formatAnswer(item.extraction?.answers[field.stableKey], field.fieldType),
    })
  }

  if (data.qualityEnabled) {
    columns.push(
      {
        key: 'quality_status',
        label: 'Quality Status',
        getValue: (item) => statusLabel(item.quality?.status),
      },
      {
        key: 'quality_reviewer',
        label: 'Assessed By',
        getValue: (item) => item.quality?.reviewerName ?? '—',
      },
      {
        key: 'quality_completed_at',
        label: 'Quality Completed',
        getValue: (item) => item.quality?.completedAt ?? null,
        render: (item) => formatDate(item.quality?.completedAt ?? null),
      },
      {
        key: 'quality_score',
        label: 'Quality Score',
        getValue: (item) => item.quality?.totalScore ?? null,
      },
    )
    for (const field of data.qualityFields) {
      columns.push({
        key: `quality:${field.stableKey}`,
        label: field.label,
        getValue: (item) => formatAnswer(item.quality?.answers[field.stableKey], field.fieldType),
      })
    }
  }

  return columns
}

function searchText(item: FinalResultItem): string {
  const parts: string[] = [
    item.publication.title,
    item.publication.authors ?? '',
    item.publication.venue ?? '',
    item.publication.doi ?? '',
    item.publication.publicationType ?? '',
    item.publication.keywords ?? '',
  ]
  if (item.extraction) {
    parts.push(item.extraction.reviewerName ?? '')
    parts.push(...Object.values(item.extraction.answers).map((value) => String(value ?? '')))
  }
  if (item.quality) {
    parts.push(item.quality.reviewerName ?? '')
    parts.push(...Object.values(item.quality.answers).map((value) => String(value ?? '')))
  }
  return parts.join(' ␟ ').toLowerCase()
}

export function FinalResultsPage() {
  const { projectId = '' } = useParams()
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('title')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const query = useQuery({
    queryKey: ['final-results', projectId],
    queryFn: () => apiRequest<FinalResultsResponse>(`/api/v1/projects/${projectId}/final-results`),
    enabled: Boolean(projectId),
  })

  const columns = useMemo(() => (query.data ? buildColumns(query.data) : []), [query.data])

  const filteredItems = useMemo(() => {
    if (!query.data) return []
    const term = search.trim().toLowerCase()
    if (!term) return query.data.items
    return query.data.items.filter((item) => searchText(item).includes(term))
  }, [query.data, search])

  const sortedItems = useMemo(() => {
    const column = columns.find((candidate) => candidate.key === sortKey)
    if (!column) return filteredItems
    const withValues = filteredItems.map((item) => ({ item, value: column.getValue(item) }))
    withValues.sort((a, b) => {
      const aValue = a.value
      const bValue = b.value
      if (aValue === null || aValue === undefined) return 1
      if (bValue === null || bValue === undefined) return -1
      if (typeof aValue === 'number' && typeof bValue === 'number') {
        return aValue - bValue
      }
      return String(aValue).localeCompare(String(bValue), undefined, { sensitivity: 'base' })
    })
    if (sortDirection === 'desc') withValues.reverse()
    return withValues.map((entry) => entry.item)
  }, [columns, filteredItems, sortKey, sortDirection])

  const pageCount = Math.max(1, Math.ceil(sortedItems.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageItems = sortedItems.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const toggleSort = (key: string) => {
    setPage(1)
    if (sortKey === key) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDirection('asc')
    }
  }

  return (
    <main className="page">
      <StageEyebrow stage="completed" />
      <h1>Final Results</h1>
      <p className="muted">
        Every publication included in the review, with its data extraction
        {query.data?.qualityEnabled ? ' and quality assessment' : ''} results. This data can also
        be downloaded from the <Link to={`/projects/${projectId}/reporting`}>Reporting and Exports</Link> page.
      </p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data ? (
        <>
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
                placeholder="Filter by title, author, DOI, or any answer…"
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
          <CountPill count={sortedItems.length}>
            of {query.data.items.length} publication{query.data.items.length === 1 ? '' : 's'}
            {search.trim() ? ' match your search' : ''}
          </CountPill>
          {sortedItems.length === 0 ? (
            <p>No publications match your search.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    {columns.map((column) => {
                      const isSorted = sortKey === column.key
                      return (
                        <th key={column.key} scope="col" aria-sort={isSorted ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <Button
                            type="button"
                            variant="text"
                            onClick={() => toggleSort(column.key)}
                          >
                            {column.label}{isSorted ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : ''}
                          </Button>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item) => (
                    <tr key={item.publication.id}>
                      {columns.map((column) => (
                        <td key={column.key}>{column.render ? column.render(item) : String(column.getValue(item) ?? '—')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pageCount > 1 ? (
            <div className="toolbar">
              <Button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={currentPage <= 1}>
                Previous
              </Button>
              <span>Page {currentPage} of {pageCount}</span>
              <Button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={currentPage >= pageCount}>
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </main>
  )
}
