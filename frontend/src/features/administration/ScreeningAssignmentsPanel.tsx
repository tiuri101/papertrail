import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import type { User } from '../auth/types'

type RoleKey = 'canTitleAbstractScreen' | 'canFullTextScreen'

interface Membership {
  id: string
  userId: string
  canTitleAbstractScreen: boolean
  canFullTextScreen: boolean
}

interface ProjectMembers {
  id: string
  memberships: Membership[]
}

interface AssignmentItem {
  id: string
  publicationId: string
  publicationTitle: string
  slotNumber: number
  status: string
  assignedReviewerId: string | null
  assignedReviewerName: string | null
}

interface AssignmentsPage {
  items: AssignmentItem[]
  total: number
  reassignableTotal: number
  page: number
  pageSize: number
}

const STAGES: Array<{ value: string; label: string; roleKey: RoleKey }> = [
  { value: 'title_abstract', label: 'Title/Abstract Screening', roleKey: 'canTitleAbstractScreen' },
  { value: 'full_text', label: 'Full-Text Screening', roleKey: 'canFullTextScreen' },
]

const STATUS_LABELS: Record<string, string> = {
  available: 'Available',
  reserved: 'Reserved',
  submitted: 'Submitted',
}

const SORT_COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'publicationTitle', label: 'Publication' },
  { key: 'slotNumber', label: 'Slot' },
  { key: 'status', label: 'Status' },
  { key: 'assignedReviewerName', label: 'Assigned Reviewer' },
]

const PAGE_SIZE = 20

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

function SortableHeader({
  column,
  sort,
  order,
  onSort,
}: {
  column: { key: string; label: string }
  sort: string
  order: 'asc' | 'desc'
  onSort: (key: string) => void
}) {
  const active = sort === column.key
  return (
    <th scope="col" aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="link-button" onClick={() => onSort(column.key)}>
        {column.label}{active ? (order === 'asc' ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  )
}

function ReassignRow({
  item,
  eligibleReviewers,
  onReassign,
  selected,
  onToggleSelected,
  pending,
}: {
  item: AssignmentItem
  eligibleReviewers: Array<{ id: string; displayName: string }>
  onReassign: (reviewerId: string) => void
  selected: boolean
  onToggleSelected: () => void
  pending: boolean
}) {
  const [selectedReviewer, setSelectedReviewer] = useState('')
  const locked = item.status === 'submitted'

  return (
    <tr className={selected ? 'assignment-row assignment-row--selected' : 'assignment-row'}>
      <td>
        <input
          type="checkbox"
          aria-label={`Select ${item.publicationTitle}, slot ${item.slotNumber}`}
          checked={selected}
          disabled={locked}
          onChange={onToggleSelected}
        />
      </td>
      <td>{item.publicationTitle}</td>
      <td>{item.slotNumber}</td>
      <td>{STATUS_LABELS[item.status] ?? item.status}</td>
      <td>{item.assignedReviewerName ?? 'Unassigned'}</td>
      <td>
        {locked ? (
          <span className="muted">Already submitted</span>
        ) : (
          <div className="toolbar">
            <select
              aria-label={`Reassign ${item.publicationTitle}`}
              value={selectedReviewer}
              onChange={(event) => setSelectedReviewer(event.target.value)}
            >
              <option value="">Select a reviewer…</option>
              {eligibleReviewers
                .filter((reviewer) => reviewer.id !== item.assignedReviewerId)
                .map((reviewer) => (
                  <option key={reviewer.id} value={reviewer.id}>{reviewer.displayName}</option>
                ))}
            </select>
            <button
              type="button"
              disabled={!selectedReviewer || pending}
              onClick={() => {
                onReassign(selectedReviewer)
                setSelectedReviewer('')
              }}
            >
              Reassign
            </button>
          </div>
        )}
      </td>
    </tr>
  )
}

export function ScreeningAssignmentsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [stage, setStage] = useState(STAGES[0].value)
  const activeStage = STAGES.find((candidate) => candidate.value === stage) ?? STAGES[0]

  const [searchInput, setSearchInput] = useState('')
  const search = useDebouncedValue(searchInput, 300)
  const [status, setStatus] = useState('')
  const [reviewerId, setReviewerId] = useState('')
  const [sort, setSort] = useState('publicationTitle')
  const [order, setOrder] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [selectAllFiltered, setSelectAllFiltered] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set())
  const [bulkReviewerId, setBulkReviewerId] = useState('')

  useEffect(() => {
    setPage(1)
    setSelectAllFiltered(false)
    setSelectedIds(new Set())
    setExcludedIds(new Set())
  }, [stage, search, status, reviewerId, sort, order])

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectMembers>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => apiRequest<User[]>('/api/v1/users'),
  })

  const queryParams = new URLSearchParams({
    sort,
    order,
    page: String(page),
    pageSize: String(PAGE_SIZE),
  })
  if (search) queryParams.set('search', search)
  if (status) queryParams.set('status', status)
  if (reviewerId) queryParams.set('reviewerId', reviewerId)
  const assignmentsQueryKey = ['screening-assignments', projectId, stage, search, status, reviewerId, sort, order, page]
  const assignments = useQuery({
    queryKey: assignmentsQueryKey,
    queryFn: () => apiRequest<AssignmentsPage>(
      `/api/v1/projects/${projectId}/screening/${stage}/assignments?${queryParams.toString()}`,
    ),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  })

  const reassign = useMutation({
    mutationFn: ({ itemId, reviewerId: newReviewerId }: { itemId: string; reviewerId: string }) => apiRequest(
      `/api/v1/projects/${projectId}/screening/work-items/${itemId}/reassign`,
      { method: 'PATCH', body: JSON.stringify({ reviewerId: newReviewerId }) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['screening-assignments', projectId, stage] }),
  })
  const bulkReassign = useMutation({
    mutationFn: () => apiRequest<{ reassigned: number }>(
      `/api/v1/projects/${projectId}/screening/${stage}/assignments/reassign`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          reviewerId: bulkReviewerId,
          workItemIds: selectAllFiltered ? [] : Array.from(selectedIds),
          selectAllFiltered,
          excludedWorkItemIds: selectAllFiltered ? Array.from(excludedIds) : [],
          search: search || null,
          status: status || null,
          filterReviewerId: reviewerId || null,
        }),
      },
    ),
    onSuccess: () => {
      setSelectAllFiltered(false)
      setSelectedIds(new Set())
      setExcludedIds(new Set())
      setBulkReviewerId('')
      return queryClient.invalidateQueries({ queryKey: ['screening-assignments', projectId, stage] })
    },
  })

  const usersById = new Map((users.data ?? []).map((user) => [user.id, user]))
  const eligibleReviewers = (project.data?.memberships ?? [])
      .filter((membership) => membership[activeStage.roleKey])
      .map((membership) => usersById.get(membership.userId))
      .filter((user): user is User => user !== undefined && user.isActive)
      .map((user) => ({
        id: user.id,
        displayName: user.displayName,
      }));

  const handleSort = (key: string) => {
    if (sort === key) {
      setOrder((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSort(key)
      setOrder('asc')
    }
  }

  const total = assignments.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const reassignableTotal = assignments.data?.reassignableTotal
    ?? assignments.data?.items.filter((item) => item.status !== 'submitted').length
    ?? 0
  const selectedCount = selectAllFiltered
    ? Math.max(0, reassignableTotal - excludedIds.size)
    : selectedIds.size

  const toggleItem = (itemId: string) => {
    if (selectAllFiltered) {
      setExcludedIds((current) => {
        const next = new Set(current)
        if (next.has(itemId)) next.delete(itemId)
        else next.add(itemId)
        return next
      })
      return
    }
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  return (
    <CollapsibleSection
      id="section-screening-assignments"
      title="Screening Assignments"
      defaultExpanded={false}
    >
      <p className="muted">Move a publication to a different reviewer who has been added to this project.</p>
      <div className="toolbar">
        <label>
          Stage
          <select value={stage} onChange={(event) => setStage(event.target.value)}>
            {STAGES.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Publication title…"
          />
        </label>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="available">Available</option>
            <option value="reserved">Reserved</option>
            <option value="submitted">Submitted</option>
          </select>
        </label>
        <label>
          Reviewer
          <select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)}>
            <option value="">All reviewers</option>
            <option value="unassigned">Unassigned</option>
            {eligibleReviewers.map((reviewer) => (
              <option key={reviewer.id} value={reviewer.id}>{reviewer.displayName}</option>
            ))}
          </select>
        </label>
      </div>
      {assignments.data && reassignableTotal > 0 ? (
        <div className="bulk-selection-panel">
          <label className="bulk-selection-panel__all">
            <input
              type="checkbox"
              checked={selectAllFiltered}
              onChange={(event) => {
                setSelectAllFiltered(event.target.checked)
                setSelectedIds(new Set())
                setExcludedIds(new Set())
              }}
            />
            Select all {reassignableTotal} filtered assignments
          </label>
          <div className="toolbar bulk-selection-panel__controls">
            <label>
              Reassign selected to
              <select
                value={bulkReviewerId}
                onChange={(event) => setBulkReviewerId(event.target.value)}
              >
                <option value="">Select a reviewer…</option>
                {eligibleReviewers.map((reviewer) => (
                  <option key={reviewer.id} value={reviewer.id}>{reviewer.displayName}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!bulkReviewerId || selectedCount === 0 || bulkReassign.isPending}
              onClick={() => bulkReassign.mutate()}
            >
              {bulkReassign.isPending ? 'Reassigning…' : `Reassign selected (${selectedCount})`}
            </button>
          </div>
          {selectAllFiltered && excludedIds.size > 0 ? (
            <p className="muted">{excludedIds.size} assignment{excludedIds.size === 1 ? '' : 's'} excluded from this selection.</p>
          ) : null}
        </div>
      ) : null}
      {bulkReassign.isSuccess ? (
        <p role="status">Reassigned {bulkReassign.data.reassigned} assignment{bulkReassign.data.reassigned === 1 ? '' : 's'}.</p>
      ) : null}
      {reassign.error || bulkReassign.error ? (
        <p className="error" role="alert">{(reassign.error ?? bulkReassign.error)?.message}</p>
      ) : null}
      {assignments.error ? <p className="error" role="alert">{assignments.error.message}</p> : null}
      {assignments.isLoading ? <p>Loading…</p> : null}
      {assignments.data && assignments.data.items.length === 0 ? (
        <p className="muted">No publications match these filters.</p>
      ) : null}
      {assignments.data && assignments.data.items.length > 0 ? (
        <>
          <table>
            <thead>
              <tr>
                <th scope="col">Select</th>
                {SORT_COLUMNS.map((column) => (
                  <SortableHeader key={column.key} column={column} sort={sort} order={order} onSort={handleSort} />
                ))}
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {assignments.data.items.map((item) => (
                <ReassignRow
                  key={item.id}
                  item={item}
                  eligibleReviewers={eligibleReviewers}
                  selected={selectAllFiltered ? !excludedIds.has(item.id) && item.status !== 'submitted' : selectedIds.has(item.id)}
                  onToggleSelected={() => toggleItem(item.id)}
                  pending={reassign.isPending || bulkReassign.isPending}
                  onReassign={(newReviewerId) => reassign.mutate({ itemId: item.id, reviewerId: newReviewerId })}
                />
              ))}
            </tbody>
          </table>
          <div className="toolbar">
            <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
              Previous
            </button>
            <span className="muted">Page {page} of {totalPages} ({total} total)</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>
              Next
            </button>
          </div>
        </>
      ) : null}
    </CollapsibleSection>
  )
}
