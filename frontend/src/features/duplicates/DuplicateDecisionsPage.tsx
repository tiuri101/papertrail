import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
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
import { PublicationListSortHeader } from '../../components/PublicationListSortHeader'
import { reviewWorkActionsClass, reviewWorkCardClass, reviewWorkEditorClass, reviewWorkListClass } from '../../components/reviewWorkStyles'
import { Select } from '../../components/Select'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { formatSubmittedAtParts } from '../../lib/format'
import { type SortDirection, sortByValue } from '../../lib/sort'
import { StageEyebrow } from '../projects/StageEyebrow'
import { DuplicateDecisionEditor } from './DuplicateDecisionEditor'
import { type Candidate, statusLabel } from './types'

interface ProjectAccess {
  stage: string
}

const GRID = 'grid grid-cols-[minmax(12rem,1fr)_10rem_9rem_minmax(6rem,8rem)_6rem] items-center gap-3 [&>*]:min-w-0 max-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[640px]:gap-y-1'

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All decisions' },
  { value: 'merged', label: 'Merged' },
  { value: 'not_duplicate', label: 'Not a duplicate' },
] as const

type StatusFilter = (typeof STATUS_FILTER_OPTIONS)[number]['value']
type SortKey = 'pair' | 'decision' | 'resolvedBy' | 'resolvedAt'

function badgeVariant(candidate: Candidate) {
  return candidate.status === 'not_duplicate' ? 'neutral' : 'success'
}

function sortValue(candidate: Candidate, key: SortKey): string | number {
  switch (key) {
    case 'pair':
      return candidate.publicationA.title.toLocaleLowerCase()
    case 'decision':
      return statusLabel(candidate).toLocaleLowerCase()
    case 'resolvedBy':
      return (candidate.resolvedByName ?? '').toLocaleLowerCase()
    case 'resolvedAt':
      return candidate.resolvedAt ? Date.parse(candidate.resolvedAt) : 0
  }
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

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectAccess>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  const candidates = useQuery({
    queryKey: ['duplicates', projectId],
    queryFn: () => apiRequest<Candidate[]>(`/api/v1/projects/${projectId}/duplicates`),
    enabled: Boolean(projectId),
  })

  const readOnly = Boolean(project.data) && project.data!.stage !== 'duplicate_review'

  const resolved = useMemo(
    () => (candidates.data ?? []).filter((candidate) => candidate.status !== 'unresolved'),
    [candidates.data],
  )

  const visible = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase()
    const filtered = resolved.filter((candidate) => {
      const haystack = [
        candidate.publicationA.title,
        candidate.publicationB.title,
        candidate.publicationA.authors,
        candidate.publicationB.authors,
        candidate.resolvedByName,
        candidate.resolutionNote,
      ].filter(Boolean).join(' ').toLocaleLowerCase()
      return (!normalized || haystack.includes(normalized))
        && (statusFilter === 'all' || candidate.status === statusFilter)
    })
    return sortByValue(
      filtered,
      sortDirection,
      (candidate) => sortValue(candidate, sortKey),
      (left, right) => left.publicationA.title.localeCompare(right.publicationA.title),
    )
  }, [resolved, search, statusFilter, sortKey, sortDirection])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDirection(key === 'resolvedAt' ? 'desc' : 'asc')
    }
  }

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
          {resolved.length > 0 ? (
            <>
              <CountPill count={search || statusFilter !== 'all' ? visible.length : resolved.length}>
                {search || statusFilter !== 'all'
                  ? `of ${resolved.length} decisions match your filters`
                  : `decision${resolved.length === 1 ? '' : 's'}`}
              </CountPill>
              <div className={`${toolbarClass} mb-4`}>
                <label className="grid min-w-[min(20rem,100%)] flex-1 gap-1 text-sm font-semibold text-text-secondary">
                  Search pairs
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Title, author, reviewer, note…"
                  />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-text-secondary">
                  Decision
                  <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                    {STATUS_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </label>
              </div>
            </>
          ) : null}
          {resolved.length === 0 ? (
            <p className="text-text-muted">No duplicate pairs have been resolved yet.</p>
          ) : visible.length === 0 ? (
            <p className="text-text-muted">No decisions match your filters.</p>
          ) : (
            <div>
              <div className={`${GRID} mt-6 mb-2 px-4 text-[0.72rem] font-bold tracking-[0.04em] text-text-muted uppercase max-[640px]:hidden`}>
                <PublicationListSortHeader label="Pair" sortKey="pair" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Decision" sortKey="decision" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Resolved by" sortKey="resolvedBy" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Resolved" sortKey="resolvedAt" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <span className={reviewWorkActionsClass}>Actions</span>
              </div>
              <ul className={reviewWorkListClass} aria-label="Duplicate decisions">
                {visible.map((candidate) => (
                  <DecisionRow
                    key={candidate.id}
                    projectId={projectId}
                    candidate={candidate}
                    readOnly={readOnly}
                    highlightKeywords={highlightKeywords}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      ) : null}
    </Page>
  )
}
