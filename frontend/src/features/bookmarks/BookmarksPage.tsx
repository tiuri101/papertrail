import type { MouseEvent } from 'react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Button } from '../../components/Button'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CountPill } from '../../components/CountPill'
import { DoiPill } from '../../components/DoiPill'
import { FieldLabel } from '../../components/FieldLabel'
import { IconDownload, IconTrash } from '../../components/icons'
import { Input } from '../../components/Input'
import { toolbarClass } from '../../components/layoutStyles'
import { Page } from '../../components/Page'
import { PublicationListSortHeader } from '../../components/PublicationListSortHeader'
import {
  reviewWorkActionsClass,
  reviewWorkCardClass,
  reviewWorkDoiClass,
  reviewWorkGridClass,
  reviewWorkListClass,
  reviewWorkMetadataClass,
  reviewWorkStatusClass,
  reviewWorkSubmittedClass,
  reviewWorkSubmittedTimeClass,
  reviewWorkTitleClass,
  reviewWorkTitleLinkClass,
  reviewWorkTitleTextClass,
  reviewWorkVenueClass,
} from '../../components/reviewWorkStyles'
import { Select } from '../../components/Select'
import { cn } from '../../lib/cn'
import { formatSubmittedAtParts } from '../../lib/format'
import { type SortDirection, sortByValue } from '../../lib/sort'
import { isJobActive } from '../jobs/jobStatus'
import { BookmarkToggle } from './BookmarkToggle'
import {
  type BookmarkItem,
  bookmarkExportDownloadHref,
  useBookmarkExportStatus,
  useBookmarkList,
  useCreateBookmarkExport,
  useRemoveBookmarks,
} from './useBookmarks'

type BookmarkSortKey = 'title' | 'authors' | 'venue' | 'year' | 'doi' | 'bookmarked'

function sortValue(item: BookmarkItem, key: BookmarkSortKey): string | number {
  switch (key) {
    case 'title': return item.title.toLocaleLowerCase()
    case 'authors': return (item.authors ?? '').toLocaleLowerCase()
    case 'venue': return (item.venue ?? '').toLocaleLowerCase()
    case 'year': return item.publicationYear ?? 0
    case 'doi': return (item.doi ?? '').toLocaleLowerCase()
    case 'bookmarked': return Date.parse(item.bookmarkedAt) || 0
  }
}

function publicationHref(item: BookmarkItem): string {
  return `/projects/${item.projectId}/publications/${item.publicationId}`
}

function BookmarkRow({ item, selected, onToggleSelected }: {
  item: BookmarkItem
  selected: boolean
  onToggleSelected: () => void
}) {
  const navigate = useNavigate()
  const href = publicationHref(item)
  const bookmarked = formatSubmittedAtParts(item.bookmarkedAt)

  const openPublication = (event: MouseEvent<HTMLLIElement>) => {
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label')) return
    navigate(href)
  }

  return (
    <li
      className={cn(reviewWorkCardClass, selected && 'border-primary bg-none bg-primary-container hover:border-primary')}
      data-selected={selected || undefined}
      onClick={openPublication}
    >
      <div className={reviewWorkGridClass}>
        <div className={reviewWorkTitleClass}>
          <div className="flex items-start gap-3">
            <Input
              className="mt-0.5 shrink-0"
              type="checkbox"
              checked={selected}
              onChange={onToggleSelected}
              aria-label={`Select ${item.title}`}
            />
            <div className="min-w-0 flex-1">
              <Link className={reviewWorkTitleLinkClass} to={href}>
                <h2 className={reviewWorkTitleTextClass}>{item.title}</h2>
              </Link>
              <div className={reviewWorkMetadataClass}>{item.authors ?? 'Unknown authors'}</div>
            </div>
          </div>
        </div>
        <span className={reviewWorkVenueClass} title={item.venue ?? undefined}>{item.venue ?? '—'}</span>
        <span className={`${reviewWorkStatusClass} ${reviewWorkMetadataClass}`}>{item.publicationYear ?? '—'}</span>
        <span className={reviewWorkDoiClass}>
          {item.doi ? <DoiPill doi={item.doi} /> : <span className="text-text-muted">—</span>}
        </span>
        <time className={reviewWorkSubmittedClass} dateTime={item.bookmarkedAt}>
          <span>{bookmarked.date}</span>
          {bookmarked.time ? <span className={reviewWorkSubmittedTimeClass}>{bookmarked.time}</span> : null}
        </time>
        <span className={reviewWorkActionsClass}>
          <BookmarkToggle projectId={item.projectId} publicationId={item.publicationId} />
        </span>
      </div>
    </li>
  )
}

export function BookmarksPage() {
  const query = useBookmarkList()
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<BookmarkSortKey>('bookmarked')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [exportJobId, setExportJobId] = useState<string | null>(null)
  const removeBookmarks = useRemoveBookmarks()
  const createExport = useCreateBookmarkExport()
  const exportStatus = useBookmarkExportStatus(exportJobId)

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const items = (query.data ?? []).filter((item) => {
      const searchable = [item.title, item.authors, item.venue, item.doi]
        .filter(Boolean).join(' ').toLocaleLowerCase()
      return !normalizedSearch || searchable.includes(normalizedSearch)
    })
    return sortByValue(
      items,
      sortDirection,
      (item) => sortValue(item, sortKey),
      (left, right) => left.title.localeCompare(right.title),
    )
  }, [query.data, search, sortDirection, sortKey])

  // Kept to bookmarks that still exist, so a removal elsewhere (the row's own
  // toggle, another tab) never leaves a phantom id in a bulk action.
  const selectedIds = useMemo(
    () => (query.data ?? []).map((item) => item.publicationId).filter((id) => selection.has(id)),
    [query.data, selection],
  )
  const allFilteredSelected = filteredItems.length > 0
    && filteredItems.every((item) => selection.has(item.publicationId))
  const toggleSelected = (id: string) => setSelection((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleSelectAll = () => setSelection((current) => {
    const next = new Set(current)
    for (const item of filteredItems) {
      if (allFilteredSelected) next.delete(item.publicationId)
      else next.add(item.publicationId)
    }
    return next
  })

  const startExport = (publicationIds: string[] | null) => createExport.mutate(publicationIds, {
    onSuccess: (result) => setExportJobId(result.jobId),
  })
  const exportRunning = createExport.isPending || (exportStatus.data ? isJobActive(exportStatus.data.status) : Boolean(exportJobId))

  const toggleSort = (key: BookmarkSortKey) => {
    if (key === sortKey) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDirection(key === 'bookmarked' || key === 'year' ? 'desc' : 'asc')
    }
  }

  return (
    <Page>
      <h1>Bookmarks</h1>
      <p className="text-text-muted">
        Publications you have bookmarked, across all your projects. Only you can see your bookmarks.
        Select a publication to open its details.
      </p>
      {query.error ? <p className="text-danger" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data ? (
        <div>
          {query.data.length > 0 ? (
            <>
              <CountPill count={search ? filteredItems.length : query.data.length}>
                {search ? `of ${query.data.length} bookmarks match your search` : `bookmark${query.data.length === 1 ? '' : 's'}`}
              </CountPill>
              <div className={toolbarClass + ' mb-4'}>
                <label className="grid min-w-[min(20rem,100%)] flex-1 gap-1 text-sm font-semibold text-text-secondary">
                  Search papers
                  <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, author, venue, DOI…" />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-text-secondary hidden max-[520px]:grid">
                  Sort by
                  <Select value={`${sortKey}:${sortDirection}`} onChange={(event) => {
                    const [key, direction] = event.target.value.split(':') as [BookmarkSortKey, SortDirection]
                    setSortKey(key)
                    setSortDirection(direction)
                  }}>
                    <option value="bookmarked:desc">Newest bookmark</option>
                    <option value="bookmarked:asc">Oldest bookmark</option>
                    <option value="title:asc">Title A–Z</option>
                    <option value="title:desc">Title Z–A</option>
                    <option value="authors:asc">Authors A–Z</option>
                    <option value="authors:desc">Authors Z–A</option>
                    <option value="venue:asc">Venue A–Z</option>
                    <option value="venue:desc">Venue Z–A</option>
                    <option value="year:desc">Newest publication</option>
                    <option value="year:asc">Oldest publication</option>
                  </Select>
                </label>
              </div>
              <div className={toolbarClass}>
                {filteredItems.length > 0 ? (
                  <FieldLabel inline>
                    <Input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAll} />
                    {' '}Select All ({filteredItems.length})
                  </FieldLabel>
                ) : null}
                {selectedIds.length > 0 ? (
                  <>
                    <span className="text-text-muted">{selectedIds.length} selected</span>
                    <Button type="button" variant="text" size="sm" onClick={() => setSelection(new Set())}>
                      Clear selection
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={exportRunning}
                      onClick={() => startExport(selectedIds)}
                    >
                      <IconDownload />
                      Export Selected ({selectedIds.length})
                    </Button>
                    <ConfirmButton
                      size="sm"
                      label={`Remove Selected (${selectedIds.length})`}
                      variant="danger"
                      warning={`Remove ${selectedIds.length} bookmark${selectedIds.length === 1 ? '' : 's'}? The publications themselves are not affected.`}
                      onConfirm={() => removeBookmarks.mutate(selectedIds, { onSuccess: () => setSelection(new Set()) })}
                      disabled={removeBookmarks.isPending}
                      icon={<IconTrash />}
                    />
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={exportRunning}
                    onClick={() => startExport(null)}
                  >
                    <IconDownload />
                    Export All ({query.data.length})
                  </Button>
                )}
              </div>
              {removeBookmarks.error ? <p className="text-danger" role="alert">{removeBookmarks.error.message}</p> : null}
              {createExport.error ? <p className="text-danger" role="alert">{createExport.error.message}</p> : null}
              {exportStatus.error ? <p className="text-danger" role="alert">{exportStatus.error.message}</p> : null}
              {exportJobId && (!exportStatus.data || isJobActive(exportStatus.data.status)) && !exportStatus.error ? (
                <p className="text-text-muted" role="status">Preparing export bundle (metadata.bib + PDFs)…</p>
              ) : null}
              {exportStatus.data?.status === 'failed' ? (
                <p className="text-danger" role="alert">
                  Export failed{exportStatus.data.errorMessage ? `: ${exportStatus.data.errorMessage}` : ''}
                </p>
              ) : null}
              {exportJobId && exportStatus.data?.status === 'completed' ? (
                <p>
                  Export ready:{' '}
                  <a href={bookmarkExportDownloadHref(exportJobId)}>Download bundle</a>
                </p>
              ) : null}
            </>
          ) : null}
          {query.data.length === 0 ? (
            <p className="text-text-muted">
              You have no bookmarks yet. Use the bookmark button on a publication — while screening or in any
              publication list — to add one.
            </p>
          ) : filteredItems.length === 0 ? (
            <p className="text-text-muted">No bookmarks match your search.</p>
          ) : (
            <>
              <div className={`${reviewWorkGridClass} mt-6 mb-2 px-4 text-[0.72rem] font-bold tracking-[0.04em] text-text-muted uppercase max-[520px]:hidden`}>
                <span className="flex items-center gap-0.5">
                  <PublicationListSortHeader label="Title" sortKey="title" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />{' / '}
                  <PublicationListSortHeader label="Authors" sortKey="authors" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                </span>
                <PublicationListSortHeader label="Venue" sortKey="venue" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Year" sortKey="year" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="DOI" sortKey="doi" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Bookmarked" sortKey="bookmarked" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <span className={reviewWorkActionsClass}>Actions</span>
              </div>
              <ul className={`${reviewWorkListClass} overflow-hidden rounded-md border border-border bg-surface`} aria-label="Bookmarked publications">
                {filteredItems.map((item) => (
                  <BookmarkRow
                    key={item.publicationId}
                    item={item}
                    selected={selection.has(item.publicationId)}
                    onToggleSelected={() => toggleSelected(item.publicationId)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </Page>
  )
}
