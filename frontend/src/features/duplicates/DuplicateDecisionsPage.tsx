import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { CountPill } from '../../components/CountPill'
import { HighlightedText } from '../../components/HighlightedText'
import { IconAlertTriangle } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Input } from '../../components/Input'
import { toolbarClass } from '../../components/layoutStyles'
import { Page } from '../../components/Page'
import { DEFAULT_TABLE_PAGE_SIZE, PaginationControls, PaginationSummary } from '../../components/Pagination'
import { PublicationListSortHeader } from '../../components/PublicationListSortHeader'
import { reviewWorkActionsClass, reviewWorkCardClass, reviewWorkEditorClass, reviewWorkListClass } from '../../components/reviewWorkStyles'
import { Select } from '../../components/Select'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { formatSubmittedAtParts } from '../../lib/format'
import { type SortDirection } from '../../lib/sort'
import { StageEyebrow } from '../projects/StageEyebrow'
import { DuplicateDecisionEditor } from './DuplicateDecisionEditor'
import { type Candidate, statusLabel } from './types'

interface ProjectAccess {
  stage: string
}

/** One server-rendered page of resolved duplicate decisions (backend/app/deduplication/listing.py). */
interface CandidatePage {
  items: Candidate[]
  total: number
  resolvedTotal: number
  page: number
  pageSize: number
  pageCount: number
  hasMore: boolean
}

const GRID = 'grid grid-cols-[minmax(12rem,1fr)_10rem_9rem_minmax(6rem,8rem)_6rem] items-center gap-3 [&>*]:min-w-0 max-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[640px]:gap-y-1'

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All decisions' },
  { value: 'merged', label: 'Merged' },
  { value: 'not_duplicate', label: 'Not a duplicate' },
] as const

type StatusFilter = (typeof STATUS_FILTER_OPTIONS)[number]['value']
type SortKey = 'pair' | 'decision' | 'resolvedBy' | 'resolvedAt'

const SEARCH_DEBOUNCE_MS = 300

/**
 * Trails `value` by `delayMs`, so a search box drives one request per pause
 * in typing rather than one per keystroke.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

function badgeVariant(candidate: Candidate) {
  return candidate.status === 'not_duplicate' ? 'neutral' : 'success'
}

function DecisionRow({
  projectId,
  candidate,
  readOnly,
  highlightKeywords,
}: {
  projectId: string
  candidate: Candidate
  readOnly: boolean
  highlightKeywords: string[]
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const resolved = formatSubmittedAtParts(candidate.resolvedAt)

  return (
    <li className={`${reviewWorkCardClass} cursor-default`}>
      <div className={GRID}>
        <div className="min-w-0 max-[640px]:col-span-2">
          <p className="m-0 truncate text-[0.95rem] text-text">
            <HighlightedText text={candidate.publicationA.title} keywords={highlightKeywords} />
          </p>
          <p className="m-0 truncate text-[0.86rem] text-text-muted">
            <span aria-hidden="true">⇄ </span>
            <HighlightedText text={candidate.publicationB.title} keywords={highlightKeywords} />
          </p>
        </div>
        <span className="flex min-w-0 items-center">
          <Badge variant={badgeVariant(candidate)}>{statusLabel(candidate)}</Badge>
        </span>
        <span className="truncate text-[0.86rem] text-text-secondary">
          {candidate.resolvedByName ?? (candidate.autoResolved ? 'Automatic' : '—')}
        </span>
        <span className="flex min-w-0 flex-col text-[0.86rem] text-text-secondary">
          <span>{resolved.date}</span>
          {resolved.time ? <span className="text-[0.78rem] text-text-muted">{resolved.time}</span> : null}
        </span>
        <span className={reviewWorkActionsClass}>
          {!editing ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
              {readOnly ? 'View' : 'Change'}
            </Button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <div className={reviewWorkEditorClass}>
          <DuplicateDecisionEditor
            projectId={projectId}
            candidate={candidate}
            readOnly={readOnly}
            onResolved={() => queryClient.invalidateQueries({ queryKey: ['duplicates', projectId] })}
            onClose={() => setEditing(false)}
          />
        </div>
      ) : null}
    </li>
  )
}

export function DuplicateDecisionsPage() {
  const { projectId = '' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('resolvedAt')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_TABLE_PAGE_SIZE)
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS)
  const listTopRef = useRef<HTMLDivElement>(null)

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectAccess>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  // Filtering, sorting and paging are applied server-side
  // (backend/app/deduplication/listing.py): a project's duplicate backlog is
  // unbounded, so the page only ever fetches one slice of what matches.
  const listParams = useMemo(() => {
    const params = new URLSearchParams()
    const trimmed = debouncedSearch.trim()
    if (trimmed) params.set('search', trimmed)
    if (statusFilter !== 'all') params.set('status', statusFilter)
    params.set('sort', sortKey)
    params.set('direction', sortDirection)
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    return params.toString()
  }, [debouncedSearch, statusFilter, sortKey, sortDirection, page, pageSize])

  const candidates = useQuery({
    queryKey: ['duplicates', projectId, 'page', listParams],
    queryFn: () => apiRequest<CandidatePage>(
      `/api/v1/projects/${projectId}/duplicates/page?${listParams}`,
    ),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  })

  const readOnly = Boolean(project.data) && project.data!.stage !== 'duplicate_review'

  // Any change to what matches invalidates the page number that was showing.
  const narrow = <T,>(apply: (value: T) => void) => (value: T) => {
    apply(value)
    setPage(1)
  }

  // Only paging should jump the view -- not a filter change resetting to page 1.
  const goToPage = (next: number) => {
    setPage(next)
    listTopRef.current?.scrollIntoView({ block: 'start' })
  }

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDirection(key === 'resolvedAt' ? 'desc' : 'asc')
    }
    setPage(1)
  }

  const items = candidates.data?.items ?? []
  const total = candidates.data?.total ?? 0
  const resolvedTotal = candidates.data?.resolvedTotal ?? 0
  const pageCount = candidates.data?.pageCount ?? 1
  const filtersActive = Boolean(search || statusFilter !== 'all')

  return (
    <Page>
      <StageEyebrow stage="duplicate_review" />
      <h1>Duplicate Review Decisions</h1>
      <p className="text-text-muted">
        Every resolved duplicate pair in this project — merged, automatically merged, or marked
        distinct — regardless of who decided it. Open one to review or change the decision.
      </p>
      <p>
        <Link to={`/projects/${projectId}/duplicates`}>← Back to duplicate review queue</Link>
      </p>
      {candidates.error ? <p className="text-danger" role="alert">{candidates.error.message}</p> : null}
      {candidates.isLoading ? <p>Loading…</p> : null}
      {candidates.data ? (
        <>
          {readOnly ? (
            <InfoBox icon={<IconAlertTriangle />} tone="warning" alert className="mt-4">
              <h3>Duplicate review is complete for this project</h3>
              <p>
                Decisions below can be viewed but not changed. To revisit a merge, move the
                project back to duplicate review from the project page.
              </p>
            </InfoBox>
          ) : null}
          {resolvedTotal > 0 ? (
            <>
              <CountPill count={filtersActive ? total : resolvedTotal}>
                {filtersActive
                  ? `of ${resolvedTotal} decisions match your filters`
                  : `decision${resolvedTotal === 1 ? '' : 's'}`}
              </CountPill>
              <div className={`${toolbarClass} mb-4`}>
                <label className="grid min-w-[min(20rem,100%)] flex-1 gap-1 text-sm font-semibold text-text-secondary">
                  Search pairs
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => narrow(setSearch)(event.target.value)}
                    placeholder="Title, author, reviewer, note…"
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-text-secondary">
                  Decision
                  <Select
                    value={statusFilter}
                    onChange={(event) => narrow(setStatusFilter)(event.target.value as StatusFilter)}
                  >
                    {STATUS_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </label>
              </div>
            </>
          ) : null}
          {resolvedTotal === 0 ? (
            <p className="text-text-muted">No duplicate pairs have been resolved yet.</p>
          ) : items.length === 0 ? (
            <p className="text-text-muted">No decisions match your filters.</p>
          ) : (
            <div ref={listTopRef}>
              <PaginationSummary
                className="mt-6"
                noun="decision"
                page={page}
                pageSize={pageSize}
                itemCount={items.length}
                total={total}
              />
              <div className={`${GRID} mt-6 mb-2 px-4 text-[0.72rem] font-bold tracking-[0.04em] text-text-muted uppercase max-[640px]:hidden`}>
                <PublicationListSortHeader label="Pair" sortKey="pair" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Decision" sortKey="decision" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Resolved by" sortKey="resolvedBy" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Resolved" sortKey="resolvedAt" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <span className={reviewWorkActionsClass}>Actions</span>
              </div>
              <ul className={reviewWorkListClass} aria-label="Duplicate decisions">
                {items.map((candidate) => (
                  <DecisionRow
                    key={candidate.id}
                    projectId={projectId}
                    candidate={candidate}
                    readOnly={readOnly}
                    highlightKeywords={highlightKeywords}
                  />
                ))}
              </ul>
              <PaginationControls
                label="Decision pages"
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                onPageChange={goToPage}
                onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
              />
            </div>
          )}
        </>
      ) : null}
    </Page>
  )
}
