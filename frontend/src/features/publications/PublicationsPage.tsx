import { toolbarClass } from '../../components/layoutStyles'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ActionListItem } from '../../components/ActionListItem'
import { actionListItemClass } from '../../components/actionListStyles'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CountPill } from '../../components/CountPill'
import { DetailList, DetailListRow } from '../../components/DetailList'
import { cardStyles } from '../../components/Card'
import { Page } from '../../components/Page'
import { DEFAULT_TABLE_PAGE_SIZE, PaginationControls, PaginationSummary } from '../../components/Pagination'
import { HighlightedText } from '../../components/HighlightedText'
import { reviewWorkTitleTextClass } from '../../components/reviewWorkStyles'
import { Input } from '../../components/Input'
import {
  IconCheckCircle,
  IconDownload,
  IconFolder,
  IconHelpCircle,
  IconPlus,
  IconSparkle,
  IconTrash,
  IconUpload,
} from '../../components/icons'
import { DoiPill } from '../../components/DoiPill'
import { BookmarkToggle } from '../bookmarks/BookmarkToggle'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublicationListSortHeader } from '../../components/PublicationListSortHeader'
import { RowActionsMenu } from '../../components/RowActionsMenu'
import { Select } from '../../components/Select'
import { InfoTooltip } from '../../components/Tooltip'
import { TabList, TabPanel } from '../../components/Tabs'
import { FullTextDocumentPanel } from '../fulltext/FullTextDocumentPanel'
import { AdministrationEyebrow } from '../projects/StageEyebrow'
import { useCanManagePublications } from '../../hooks/useCanManageProject'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { cn } from '../../lib/cn'
import { BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'
import { BrowserPdfRetrievalPanel } from '../fulltext/BrowserPdfRetrievalPanel'
import { AddPublicationForm } from './AddPublicationPage'
import { BulkPdfUploadPanel } from './BulkPdfUploadPanel'
import { PublicationFieldInputs } from './publicationFields'

import { PublicationDraft, toPayload } from './publicationFieldsData'
import { FieldLabel } from '../../components/FieldLabel'
import { Form } from '../../components/Form'
import {
  primaryStage,
  type Publication,
  type PublicationSortKey,
  type SortDirection,
} from './publicationShared'
import {InfoBox} from "../../components/InfoBox";

/** One server-rendered page of publications (backend/app/publications/listing.py). */
interface PublicationPage {
  items: Publication[]
  /** Matching the current filters, across every page. */
  total: number
  /** Active publications in the project, ignoring the filters. */
  projectTotal: number
  /** Publications with no attached PDF, project-wide and unfiltered. */
  missingPdfCount: number
  page: number
  pageSize: number
  pageCount: number
  hasMore: boolean
}

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

const dangerRowActionItemClass = actionListItemClass({ danger: true })

const publicationRowGridClass = "grid grid-cols-[1.5rem_minmax(0,1fr)_3.25rem_9rem_6.5rem_4.5rem_4.5rem] items-center gap-3 [&>*]:min-w-0 max-[900px]:grid-cols-[1.5rem_auto_minmax(0,1fr)_auto_auto] max-[900px]:grid-rows-[auto_auto] max-[900px]:[grid-template-areas:'checkbox_title_title_title_actions'_'._year_source_stage_pdf'] max-[900px]:gap-y-2 max-[600px]:grid-cols-[auto_minmax(0,1fr)_auto] max-[600px]:grid-rows-[auto_auto] max-[600px]:[grid-template-areas:'checkbox_title_actions'_'meta_meta_meta'] max-[600px]:gap-x-2 max-[600px]:gap-y-1"

const SCREENING_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'include', label: 'Included' },
  { value: 'exclude', label: 'Excluded' },
  { value: 'uncertain', label: 'Uncertain' },
]

const PDF_STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'available', label: 'PDF available' },
  { value: 'unavailable', label: 'No PDF' },
]

function toDraft(publication: Publication): PublicationDraft {
  return {
    title: publication.title,
    authors: publication.authors ?? '',
    abstract: publication.abstract ?? '',
    publicationYear: publication.publicationYear ? String(publication.publicationYear) : '',
    venue: publication.venue ?? '',
    publicationType: publication.publicationType ?? '',
    doi: publication.doi ?? '',
    publisherUrl: publication.publisherUrl ?? '',
    keywords: publication.keywords ?? '',
    isbn: publication.isbn ?? '',
    issn: publication.issn ?? '',
    pubmedId: publication.pubmedId ?? '',
    arxivId: publication.arxivId ?? '',
  }
}

export function PublicationEditForm({
  publication,
  projectId,
  onDone,
}: {
  publication: Publication
  projectId: string
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(() => toDraft(publication))

  const setField = (field: keyof PublicationDraft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }))

  const update = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/publications/${publication.id}`, {
      method: 'PATCH',
      body: JSON.stringify(toPayload(draft)),
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['publications', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['audit', projectId] }),
      ])
      onDone()
    },
  })

  return (
    <Form onSubmit={(event) => { event.preventDefault(); update.mutate() }}>
      <PublicationFieldInputs draft={draft} setField={setField} />
      {update.error ? <p className="text-danger" role="alert">{update.error.message}</p> : null}
      <div className={toolbarClass}>
        <Button type="submit" disabled={update.isPending}><IconCheckCircle />Save</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </Form>
  )
}

interface MetadataConflict {
  id: string
  publicationId: string
  fieldName: string
  currentValue: string | null
  proposedValue: string | null
  sourceName: string
  status: string
  publication?: Publication
}

const PUBLICATION_METADATA_FIELDS: Array<{ label: string; value: (publication: Publication) => string | number | null }> = [
  { label: 'Title', value: (publication) => publication.title },
  { label: 'Authors', value: (publication) => publication.authors },
  { label: 'Year', value: (publication) => publication.publicationYear },
  { label: 'Venue', value: (publication) => publication.venue },
  { label: 'Publication type', value: (publication) => publication.publicationType },
  { label: 'DOI', value: (publication) => publication.doi },
  { label: 'Publisher URL', value: (publication) => publication.publisherUrl },
  { label: 'Keywords', value: (publication) => publication.keywords },
  { label: 'ISBN', value: (publication) => publication.isbn },
  { label: 'ISSN', value: (publication) => publication.issn },
  { label: 'PubMed ID', value: (publication) => publication.pubmedId },
  { label: 'arXiv ID', value: (publication) => publication.arxivId },
  { label: 'Abstract', value: (publication) => publication.abstract },
]

function humanizeMetadataField(fieldName: string): string {
  const value = fieldName.replace(/_/g, ' ')
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function metadataSourceLabel(sourceName: string): string {
  if (sourceName === 'crossref') return 'Crossref'
  if (sourceName === 'semantic_scholar') return 'Semantic Scholar'
  if (sourceName === 'merge') return 'Duplicate merge'
  return sourceName.replace(/_/g, ' ')
}

function metadataConflictExplanation(conflict: MetadataConflict): string {
  const field = humanizeMetadataField(conflict.fieldName).toLowerCase()
  if (conflict.sourceName === 'merge') {
    return `The other record in a duplicate merge contained a different non-empty ${field}. Papertrail kept the canonical record's current value and queued this alternative for review.`
  }
  if (conflict.sourceName === 'crossref' || conflict.sourceName === 'semantic_scholar') {
    return `${metadataSourceLabel(conflict.sourceName)} returned a different ${field} while enriching this publication. Papertrail does not overwrite an existing important field automatically, so the returned value was queued for review.`
  }
  return `${metadataSourceLabel(conflict.sourceName)} supplied a different ${field}. Because this field already had a value, Papertrail queued the alternative for review instead of overwriting it.`
}

function PublicationRow({
  publication,
  projectId,
  selected,
  onToggleSelected,
  highlightKeywords,
  canManage,
}: {
  publication: Publication
  projectId: string
  selected: boolean
  onToggleSelected: () => void
  highlightKeywords: string[]
  canManage: boolean
}) {
  const queryClient = useQueryClient()
  const [showFullText, setShowFullText] = useState(false)

  const refreshPublications = () => queryClient.invalidateQueries({ queryKey: ['publications', projectId] })

  const remove = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/publications/${publication.id}`, {
      method: 'DELETE',
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['publications', projectId] }),
  })
  const enrich = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/publications/${publication.id}/enrich`, {
      method: 'POST',
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs', projectId] }),
  })

  const stage = primaryStage(publication)
  const detailHref = `/projects/${projectId}/publications/${publication.id}`

  return (
    <li data-publication-row="true" data-selected={selected || undefined} className={cn(
      'relative rounded-md border border-border bg-linear-to-b from-surface-raised to-surface px-4 py-3 shadow-sm transition-[border-color,background-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md max-[600px]:px-3 max-[600px]:py-2',
      selected && 'border-primary bg-none bg-primary-container hover:border-primary',
    )}>
      <div className={publicationRowGridClass}>
        <span className="flex items-center max-[900px]:[grid-area:checkbox]">
          {canManage ? (
            <Input
              className="shrink-0"
              type="checkbox"
              checked={selected}
              onChange={onToggleSelected}
              aria-label={`Select ${publication.title}`}
            />
          ) : null}
        </span>
        <div className="flex min-w-0 items-start gap-2 max-[900px]:[grid-area:title]">
          <div className="min-w-0 flex-1">
            <Link className="h-auto min-h-0 whitespace-normal text-left text-text [overflow-wrap:anywhere] hover:text-primary hover:no-underline" to={detailHref}>
              <h2 className={reviewWorkTitleTextClass}><HighlightedText text={publication.title} keywords={highlightKeywords} /></h2>
            </Link>
            <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.86rem] text-text-secondary">{publication.authors ?? 'Unknown authors'}</div>
          </div>
          <BookmarkToggle projectId={projectId} publicationId={publication.id} />
        </div>
        <div className="contents [&>*]:min-w-0 max-[600px]:flex max-[600px]:flex-wrap max-[600px]:items-center max-[600px]:gap-x-3 max-[600px]:gap-y-1 max-[600px]:text-[0.8rem] max-[600px]:[grid-area:meta]">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.86rem] text-text-secondary max-[900px]:[grid-area:year] max-[600px]:text-[inherit]">{publication.publicationYear ?? '—'}</span>
          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.86rem] text-text-secondary max-[900px]:[grid-area:source] max-[600px]:text-[inherit]" title={publication.venue ?? undefined}>
            {publication.venue ?? '—'}
          </span>
          <span className="max-[900px]:[grid-area:stage]">
            <Badge variant={stage.variant}>{stage.label}</Badge>
          </span>
          <span className="mr-2 flex items-center max-[900px]:[grid-area:pdf] max-[600px]:mr-0">
            <PdfAvailabilityPill
              available={Boolean(publication.fullText?.available)}
              href={`/api/v1/projects/${projectId}/publications/${publication.id}/full-text/content`}
              pageCount={publication.fullText?.document?.pageCount}
              compact
            />
          </span>
        </div>
        <span className="flex items-center justify-end gap-1 max-[900px]:[grid-area:actions] max-[600px]:self-start">
          <DoiPill doi={publication.doi} />
          {canManage ? (
            <RowActionsMenu label={`More actions for ${publication.title}`}>
              <ActionListItem as={Link} to={`${detailHref}?edit=1`}>Edit Metadata</ActionListItem>
              <ActionListItem
                type="button"
                onClick={() => enrich.mutate()}
                disabled={enrich.isPending || !publication.doi}
              >
                Enrich Metadata
              </ActionListItem>
              <ActionListItem
                type="button"
                onClick={() => setShowFullText((current) => !current)}
              >
                {showFullText ? 'Hide PDF' : publication.fullText?.available ? 'Manage PDF' : 'Attach PDF'}
              </ActionListItem>
              <ActionListItem
                as="a"
                href={`/api/v1/projects/${projectId}/publications/${publication.id}/export/bib`}
                target="_blank"
                rel="noreferrer"
              >
                Export BibTeX
              </ActionListItem>
              {publication.fullText?.available ? (
                <ActionListItem
                  as="a"
                  href={`/api/v1/projects/${projectId}/publications/${publication.id}/export/pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Export PDF
                </ActionListItem>
              ) : null}
              <ConfirmButton
                label="Delete"
                variant="danger"
                className={dangerRowActionItemClass}
                warning={`Delete "${publication.title}"? This cannot be undone.`}
                onConfirm={() => remove.mutate()}
                disabled={remove.isPending}
                icon={<IconTrash />}
              />
            </RowActionsMenu>
          ) : null}
        </span>
      </div>
      {canManage && showFullText ? (
        <FullTextDocumentPanel
          projectId={projectId}
          publicationId={publication.id}
          onAvailable={refreshPublications}
          onRemoved={refreshPublications}
        />
      ) : null}
      {enrich.isSuccess ? <p className="text-text-muted">Enrichment queued.</p> : null}
      {enrich.error ? <p className="text-danger" role="alert">{enrich.error.message}</p> : null}
      {remove.error ? <p className="text-danger" role="alert">{remove.error.message}</p> : null}
    </li>
  )
}

/** One server-rendered page of open metadata conflicts
 * (backend/app/publications/conflict_listing.py). */
interface ConflictPage {
  items: MetadataConflict[]
  /** Matching the current filters, across every page. */
  total: number
  /** Open conflicts in the project, ignoring the filters. */
  projectTotal: number
  page: number
  pageSize: number
  pageCount: number
  hasMore: boolean
  /** Open-conflict count per source, project-wide and unfiltered — drives the
   * source dropdown and the project-wide merge-conflict hint. */
  sourceCounts: Record<string, number>
  /** Distinct conflicting field names, project-wide and unfiltered. */
  fieldNames: string[]
}

type ConflictSortValue =
  | 'created:desc'
  | 'created:asc'
  | 'publication:asc'
  | 'publication:desc'
  | 'field:asc'
  | 'field:desc'
  | 'source:asc'
  | 'source:desc'

function MetadataConflictsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [fieldFilter, setFieldFilter] = useState('')
  const [sort, setSort] = useState<ConflictSortValue>('created:desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_TABLE_PAGE_SIZE)
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS)
  const listTopRef = useRef<HTMLUListElement>(null)

  const listParams = useMemo(() => {
    const params = new URLSearchParams()
    const trimmed = debouncedSearch.trim()
    if (trimmed) params.set('search', trimmed)
    if (sourceFilter) params.set('source', sourceFilter)
    if (fieldFilter) params.set('field', fieldFilter)
    const [sortKey, direction] = sort.split(':')
    params.set('sort', sortKey)
    params.set('direction', direction)
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    return params.toString()
  }, [debouncedSearch, sourceFilter, fieldFilter, sort, page, pageSize])

  const conflicts = useQuery({
    // Nested under ['metadata-conflicts', projectId] so the resolve mutation
    // and the project dashboard's own query both still invalidate whichever
    // page is on screen.
    queryKey: ['metadata-conflicts', projectId, 'page', listParams],
    queryFn: () => apiRequest<ConflictPage>(
      `/api/v1/projects/${projectId}/metadata-conflicts/page?${listParams}`,
    ),
    placeholderData: keepPreviousData,
  })

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

  const resolve = useMutation({
    mutationFn: (variables: { conflictId: string; acceptProposed: boolean }) => apiRequest(
      `/api/v1/projects/${projectId}/metadata-conflicts/${variables.conflictId}/resolve`,
      { method: 'POST', body: JSON.stringify({ acceptProposed: variables.acceptProposed }) },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['metadata-conflicts', projectId] })
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    },
  })

  const bulkResolveViaProvider = useMutation({
    mutationFn: () => apiRequest<{ queuedCount: number }>(
      `/api/v1/projects/${projectId}/metadata-conflicts/resolve-via-provider`,
      { method: 'POST' },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs', projectId] }),
  })

  useEffect(() => {
    if (!conflicts.data?.items.length || window.location.hash !== '#metadata-conflicts') return
    document.getElementById('metadata-conflicts')?.scrollIntoView({ block: 'start' })
  }, [conflicts.data])

  // Hidden entirely only when the project has no open conflicts at all -- once
  // it has some, the panel stays mounted so its filters can narrow to zero
  // without the controls vanishing.
  if (!conflicts.error && (!conflicts.data || conflicts.data.projectTotal === 0)) return null

  const items = conflicts.data?.items ?? []
  const total = conflicts.data?.total ?? 0
  const pageCount = conflicts.data?.pageCount ?? 1
  const sourceCounts = conflicts.data?.sourceCounts ?? {}
  const fieldNames = conflicts.data?.fieldNames ?? []
  const mergeConflictCount = sourceCounts.merge ?? 0
  const filtersActive = Boolean(search || sourceFilter || fieldFilter)

  return (
    <section className={cardStyles} data-ui="card" id="metadata-conflicts">
      <h2>Metadata Conflicts</h2>
      <p className="text-text-muted">Enrichment or a duplicate merge proposed a different value for a field that already had one. Review each side by side and choose which value to keep.</p>
      {mergeConflictCount > 0 ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-raised/50 p-4">
          <div className="min-w-0 grow">
            <strong className="text-text">Try automatic resolution</strong>
            <p className="mb-0 mt-0.5 text-[0.86rem] text-text-muted">
              Ask Crossref/Semantic Scholar to break the tie on {mergeConflictCount} merge conflict{mergeConflictCount === 1 ? '' : 's'} — a provider value that agrees with either side resolves it automatically; anything it can&apos;t confirm stays here for you.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => bulkResolveViaProvider.mutate()}
            loading={bulkResolveViaProvider.isPending}
          >
            Resolve via Provider
          </Button>
        </div>
      ) : null}
      {bulkResolveViaProvider.isSuccess ? (
        <p className="text-success" role="status">
          {bulkResolveViaProvider.data.queuedCount > 0
            ? `Queued ${bulkResolveViaProvider.data.queuedCount} publication${bulkResolveViaProvider.data.queuedCount === 1 ? '' : 's'} for provider resolution. Check back shortly.`
            : 'No eligible conflicts to resolve — the remaining ones have no DOI to look up.'}
        </p>
      ) : null}
      {bulkResolveViaProvider.error ? <p className="text-danger" role="alert">{bulkResolveViaProvider.error.message}</p> : null}
      {conflicts.error ? <p className="text-danger" role="alert">{conflicts.error.message}</p> : null}
      {resolve.error ? <p className="text-danger" role="alert">{resolve.error.message}</p> : null}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="w-full flex-[0_1_24rem]">
          Search conflicts
          <Input
            type="search"
            value={search}
            onChange={(event) => narrow(setSearch)(event.target.value)}
            placeholder="Publication title, field, value…"
          />
        </label>
        <FieldLabel>
          Source
          <Select value={sourceFilter} onChange={(event) => narrow(setSourceFilter)(event.target.value)}>
            <option value="">All sources</option>
            {Object.keys(sourceCounts).sort().map((source) => (
              <option key={source} value={source}>
                {metadataSourceLabel(source)} ({sourceCounts[source]})
              </option>
            ))}
          </Select>
        </FieldLabel>
        <FieldLabel>
          Field
          <Select value={fieldFilter} onChange={(event) => narrow(setFieldFilter)(event.target.value)}>
            <option value="">All fields</option>
            {fieldNames.map((name) => (
              <option key={name} value={name}>{humanizeMetadataField(name)}</option>
            ))}
          </Select>
        </FieldLabel>
        <FieldLabel>
          Sort by
          <Select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as ConflictSortValue)
              setPage(1)
            }}
          >
            <option value="created:desc">Newest first</option>
            <option value="created:asc">Oldest first</option>
            <option value="publication:asc">Publication A–Z</option>
            <option value="publication:desc">Publication Z–A</option>
            <option value="field:asc">Field A–Z</option>
            <option value="field:desc">Field Z–A</option>
            <option value="source:asc">Source A–Z</option>
            <option value="source:desc">Source Z–A</option>
          </Select>
        </FieldLabel>
      </div>
      <PaginationSummary
        className="mt-5"
        noun="conflict"
        page={page}
        pageSize={pageSize}
        itemCount={items.length}
        total={total}
      />
      <ul ref={listTopRef} className="mt-5 grid list-none gap-6 p-0 scroll-mt-[92px]">
        {items.map((conflict) => (
          <li key={conflict.id} className="overflow-hidden rounded-lg border border-border bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)] shadow-sm">
            <header className="flex items-center justify-between gap-4 border-b border-border bg-[color-mix(in_srgb,var(--color-surface-raised)_72%,transparent)] px-5 py-4 max-[680px]:flex-col max-[680px]:items-start max-[680px]:p-4 [&_h3]:mb-0 [&_h3]:mt-0.5 [&_h3]:text-base">
              <div>
                <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.08em] text-primary">Metadata conflict</span>
                <h3>{conflict.publication?.title ?? conflict.currentValue ?? 'Publication'}</h3>
              </div>
              <span className="shrink-0 rounded-full bg-primary-container px-2.5 py-1 text-xs font-bold text-primary">
                Proposed by {metadataSourceLabel(conflict.sourceName)}
              </span>
            </header>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(13rem,0.62fr)_minmax(0,1fr)] [grid-template-areas:'current_reason_proposed'] items-stretch gap-5 p-5 max-[1020px]:grid-cols-2 max-[1020px]:[grid-template-areas:'current_proposed'_'reason_reason'] max-[680px]:grid-cols-1 max-[680px]:[grid-template-areas:'current'_'proposed'_'reason'] max-[680px]:p-4">
              <section className="[--metadata-accent:var(--kw-1-fg)] [grid-area:current] min-w-0 overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--metadata-accent)_32%,var(--color-border))] bg-bg-elevated">
                <header className="flex items-center gap-3 border-b border-border bg-[color-mix(in_srgb,var(--metadata-accent)_8%,var(--color-surface-raised))] p-4 [&_h4]:m-0 [&_h4]:text-[0.95rem] [&_p]:mb-0 [&_p]:mt-0.5 [&_p]:text-xs [&_p]:text-text-muted">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-sm border border-[color-mix(in_srgb,var(--metadata-accent)_55%,var(--color-border))] bg-[color-mix(in_srgb,var(--metadata-accent)_14%,transparent)] text-[1.05rem] font-extrabold text-(--metadata-accent) shadow-[0_0_0_3px_color-mix(in_srgb,var(--metadata-accent)_8%,transparent)]" aria-hidden="true">A</span>
                  <div>
                    <h4>Current Value</h4>
                    <p>{humanizeMetadataField(conflict.fieldName)}</p>
                  </div>
                </header>
                <div className="min-w-0 whitespace-pre-wrap p-5 text-[0.96rem] font-semibold leading-normal text-text [overflow-wrap:anywhere]">
                  {conflict.currentValue ?? <span className="text-text-muted">(empty)</span>}
                </div>
              </section>
              <aside className="[grid-area:reason] min-w-0 self-center rounded-md border border-[color-mix(in_srgb,var(--color-primary)_25%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-primary-container)_52%,transparent)] p-4 text-center max-[1020px]:w-full max-[1020px]:text-left [&_h4]:mb-1 [&_h4]:mt-2 [&_h4]:text-sm [&_p]:m-0 [&_p]:text-[0.8rem] [&_p]:leading-normal [&_p]:text-text-secondary">
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-primary-container-hover text-primary [&_svg]:size-4 [&_svg]:fill-current" aria-hidden="true">
                  <IconSparkle />
                </span>
                <h4>Why was this proposed?</h4>
                <p>{metadataConflictExplanation(conflict)}</p>
              </aside>
              <section className="[--metadata-accent:var(--kw-4-fg)] [grid-area:proposed] min-w-0 overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--metadata-accent)_32%,var(--color-border))] bg-bg-elevated">
                <header className="flex items-center gap-3 border-b border-border bg-[color-mix(in_srgb,var(--metadata-accent)_8%,var(--color-surface-raised))] p-4 [&_h4]:m-0 [&_h4]:text-[0.95rem] [&_p]:mb-0 [&_p]:mt-0.5 [&_p]:text-xs [&_p]:text-text-muted">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-sm border border-[color-mix(in_srgb,var(--metadata-accent)_55%,var(--color-border))] bg-[color-mix(in_srgb,var(--metadata-accent)_14%,transparent)] text-[1.05rem] font-extrabold text-(--metadata-accent) shadow-[0_0_0_3px_color-mix(in_srgb,var(--metadata-accent)_8%,transparent)]" aria-hidden="true">B</span>
                  <div>
                    <h4>Proposed Value</h4>
                    <p>{humanizeMetadataField(conflict.fieldName)}</p>
                  </div>
                </header>
                <div className="min-w-0 whitespace-pre-wrap p-5 text-[0.96rem] font-semibold leading-normal text-text [overflow-wrap:anywhere]">
                  {conflict.proposedValue ?? <span className="text-text-muted">(empty)</span>}
                </div>
              </section>
            </div>
            {conflict.publication ? (
              <details className="mx-5 mb-5 rounded-md border border-border bg-bg-elevated px-4 py-3 max-[680px]:mx-4 max-[680px]:mb-4 [&>summary]:cursor-pointer [&>summary]:text-[0.86rem] [&>summary]:font-semibold [&>summary]:text-primary">
                <summary>All publication metadata</summary>
                <DetailList className="[&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere]">
                  {PUBLICATION_METADATA_FIELDS.map((field) => {
                    const value = field.value(conflict.publication!)
                    return (
                      <DetailListRow key={field.label}>
                        <dt>{field.label}</dt>
                        <dd>{value || <span className="text-text-muted">(empty)</span>}</dd>
                      </DetailListRow>
                    )
                  })}
                </DetailList>
              </details>
            ) : null}
            <section className="flex items-center justify-between gap-5 border-t border-border bg-[color-mix(in_srgb,var(--color-surface-raised)_52%,transparent)] px-5 py-4 max-[1020px]:flex-col max-[1020px]:items-start max-[680px]:p-4 [&_h4]:m-0 [&_p]:mb-0 [&_p]:mt-0.5 [&_p]:text-[0.8rem] [&_p]:text-text-muted">
              <div>
                <h4>Your Decision</h4>
                <p>Choose which value Papertrail should keep for this publication.</p>
              </div>
              <div className="grid grid-cols-2 gap-3 max-[1020px]:w-full max-[680px]:grid-cols-1">
              <Button
                type="button"
                variant="secondary"
                className="h-auto min-h-17 min-w-0 justify-start whitespace-normal px-4 py-3 text-left hover:not-disabled:border-(--kw-1-fg)"
                aria-label="Keep Current Value"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ conflictId: conflict.id, acceptProposed: false })}
              >
                <span className="inline-flex size-[1.4rem] shrink-0 items-center justify-center rounded-full border-2 border-[color-mix(in_srgb,var(--kw-1-fg)_62%,var(--color-border))] text-(--kw-1-fg)" aria-hidden="true" />
                <span className="grid min-w-0 gap-1">
                  <strong className="text-text">Keep Current Value</strong>
                  <small className="text-xs font-medium text-text-muted">Retain Value A</small>
                </span>
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="h-auto min-h-17 min-w-0 justify-start whitespace-normal px-4 py-3 text-left hover:not-disabled:border-(--kw-4-fg)"
                aria-label="Use Proposed Value"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ conflictId: conflict.id, acceptProposed: true })}
              >
                <span className="inline-flex size-[1.4rem] shrink-0 items-center justify-center rounded-full border-2 border-[color-mix(in_srgb,var(--kw-4-fg)_62%,var(--color-border))] text-(--kw-4-fg) [&_svg]:size-3 [&_svg]:fill-current"><IconCheckCircle /></span>
                <span className="grid min-w-0 gap-1">
                  <strong className="text-text">Use Proposed Value</strong>
                  <small className="text-xs font-medium text-text-muted">Replace it with Value B</small>
                </span>
              </Button>
              </div>
            </section>
          </li>
        ))}
      </ul>
      {conflicts.data && items.length === 0 ? (
        <p className="text-text-muted">
          {filtersActive
            ? 'No open conflicts match your filters.'
            : 'No open metadata conflicts.'}
        </p>
      ) : null}
      {items.length > 0 ? (
        <PaginationControls
          label="Metadata conflict pages"
          page={page}
          pageCount={pageCount}
          pageSize={pageSize}
          onPageChange={goToPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
        />
      ) : null}
    </section>
  )
}

type PublicationsTabId = 'publications' | 'add' | 'metadata' | 'pdf_retrieval'

interface PublicationsTab {
  id: PublicationsTabId
  label: string
  icon: ReactNode
}

const publicationsTabs: PublicationsTab[] = [
  { id: 'publications', label: 'Publications', icon: <IconFolder /> },
  { id: 'add', label: 'Add Publication', icon: <IconPlus /> },
  { id: 'metadata', label: 'Metadata Tools', icon: <IconSparkle /> },
  { id: 'pdf_retrieval', label: 'PDF Retrieval', icon: <IconUpload /> },
]

export function PublicationsPage() {
  const { projectId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const canManage = useCanManagePublications(projectId)
  const highlightKeywords = useHighlightKeywords(projectId)
  const requestedTab = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState<PublicationsTabId>(
    requestedTab === 'metadata' ? 'metadata' : 'publications',
  )
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [pendingExportJobId, setPendingExportJobId] = useState<string | null>(null)
  const [titleAbstractFilter, setTitleAbstractFilter] = useState('')
  const [fullTextFilter, setFullTextFilter] = useState('')
  const [pdfStatusFilter, setPdfStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<PublicationSortKey>('title')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_TABLE_PAGE_SIZE)
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS)
  const tableTopRef = useRef<HTMLUListElement>(null)

  // Only paging to a different page should jump the view -- not the initial
  // load or a filter/search/sort change resetting back to page 1.
  const goToPage = (next: number) => {
    setPage(next)
    tableTopRef.current?.scrollIntoView({ block: 'start' })
  }

  // Search, the three filters and the six sort keys are all applied by the
  // server now (backend/app/publications/listing.py). The project's whole
  // publication list is unbounded, so it is never fetched: what used to be
  // `useMemo` over everything is a request for one page of what matches.
  const filterParams = useMemo(() => {
    const params = new URLSearchParams()
    const trimmed = debouncedSearch.trim()
    if (trimmed) params.set('search', trimmed)
    if (titleAbstractFilter) params.set('titleAbstract', titleAbstractFilter)
    if (fullTextFilter) params.set('fullText', fullTextFilter)
    if (pdfStatusFilter) params.set('pdfStatus', pdfStatusFilter)
    return params.toString()
  }, [debouncedSearch, titleAbstractFilter, fullTextFilter, pdfStatusFilter])

  const listParams = useMemo(() => {
    const params = new URLSearchParams(filterParams)
    params.set('sort', sortKey)
    params.set('direction', sortDirection)
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    return params.toString()
  }, [filterParams, sortKey, sortDirection, page, pageSize])

  const query = useQuery({
    // Nested under ['publications', projectId] so every existing invalidation
    // of that prefix -- imports, merges, PDF attachment, deletion -- still
    // refreshes whichever page is on screen.
    queryKey: ['publications', projectId, 'page', listParams],
    queryFn: () => apiRequest<PublicationPage>(
      `/api/v1/projects/${projectId}/publications?${listParams}`,
    ),
    // Keep the current page visible while the next one loads, so paging and
    // filtering don't blank the list on every keystroke.
    placeholderData: keepPreviousData,
  })

  const publications = query.data?.items ?? []
  const total = query.data?.total ?? 0
  const projectTotal = query.data?.projectTotal ?? 0
  const missingPdfCount = query.data?.missingPdfCount ?? 0
  const pageCount = query.data?.pageCount ?? 1
  const filtersActive = Boolean(search || titleAbstractFilter || fullTextFilter || pdfStatusFilter)

  // Any change to what matches invalidates the page number that was showing:
  // page 4 of a 200-record list is nowhere in a 3-record one.
  const narrow = <T,>(apply: (value: T) => void) => (value: T) => {
    apply(value)
    setPage(1)
  }

  const toggleSort = (key: PublicationSortKey) => {
    if (key === sortKey) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDirection('asc')
    }
    setPage(1)
  }

  const bulkEnrich = useMutation({
    mutationFn: (variables: { publicationIds?: string[]; missingOnly: boolean }) => apiRequest<{ jobIds: string[] }>(
      `/api/v1/projects/${projectId}/publications/enrich`,
      {
        method: 'POST',
        body: JSON.stringify({
          publicationIds: variables.publicationIds,
          missingOnly: variables.missingOnly,
        }),
      },
    ),
    onSuccess: () => {
      setSelectedIds(new Set())
      queryClient.invalidateQueries({ queryKey: ['jobs', projectId] })
    },
  })

  const bulkDelete = useMutation({
    mutationFn: (publicationIds: string[]) => apiRequest<{ deletedCount: number }>(
      `/api/v1/projects/${projectId}/publications/delete`,
      { method: 'POST', body: JSON.stringify({ publicationIds }) },
    ),
    onSuccess: () => {
      setSelectedIds(new Set())
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    },
  })

  const bulkExport = useMutation({
    mutationFn: (publicationIds: string[]) => apiRequest<{ jobId: string }>(
      `/api/v1/projects/${projectId}/exports`,
      {
        method: 'POST',
        body: JSON.stringify({ exportType: 'pdf_bundle', publicationIds }),
      },
    ),
    onSuccess: (result) => {
      if (result?.jobId) setPendingExportJobId(result.jobId)
    },
  })

  const exportJobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId) && Boolean(pendingExportJobId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 2000 : false),
  })
  const pendingExportJob = pendingExportJobId ? findJob(exportJobs.data, pendingExportJobId) : undefined
  const exportArtifactId = pendingExportJob?.result?.artifactId

  useEffect(() => {
    if (pendingExportJob && !isJobActive(pendingExportJob.status)) {
      queryClient.invalidateQueries({ queryKey: ['exports', projectId] })
    }
  }, [pendingExportJob, projectId, queryClient])

  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // Selection is by id and survives paging, so a reviewer can gather records
  // from several pages before acting on them.
  const allPageSelected = publications.length > 0
    && publications.every((publication) => selectedIds.has(publication.id))

  const toggleSelectPage = () => setSelectedIds((current) => {
    const next = new Set(current)
    if (allPageSelected) {
      publications.forEach((publication) => next.delete(publication.id))
    } else {
      publications.forEach((publication) => next.add(publication.id))
    }
    return next
  })

  // "Select every publication matching the current filter" is a real
  // capability -- it is how a whole cohort gets queued for metadata
  // enrichment or exported -- and paging must not quietly reduce it to
  // "select the fifty rows on screen". The ids alone are cheap to fetch; the
  // hydrated records they stand for are exactly what paging exists to avoid.
  const selectAllMatching = useMutation({
    mutationFn: () => apiRequest<{ ids: string[]; total: number }>(
      `/api/v1/projects/${projectId}/publications/ids${filterParams ? `?${filterParams}` : ''}`,
    ),
    onSuccess: (result) => setSelectedIds(new Set(result.ids)),
  })

  const visibleTabs = publicationsTabs.filter((tab) => tab.id !== 'metadata' || canManage)

  return (
    <Page>
      <AdministrationEyebrow />
      <h1>Publications</h1>
      <TabList
        idPrefix="publications"
        label="Publications sections"
        activeId={activeTab}
        onSelect={(id) => setActiveTab(id as PublicationsTabId)}
        className="mb-6"
        items={visibleTabs.map((tab) => ({ id: tab.id, label: <>{tab.icon}{tab.label}</> }))}
      />
      <TabPanel idPrefix="publications" id={activeTab}>
        {activeTab === 'publications' ? (
          // A plain block (not a Fragment): TabPanel's `flex flex-col gap-6` would otherwise
          // apply between every one of this tab's direct children *in addition to* each one's
          // own margin (gap and margin don't collapse together the way two margins do), roughly
          // doubling every gap in this tab. Wrapping in a block lets each child's own margin
          // collapse normally with its neighbors instead.
          <div>
            {query.data && filtersActive ? (
              <CountPill count={total}>
                of {projectTotal} publications match your filters
              </CountPill>
            ) : query.data ? (
              <CountPill count={projectTotal}>
                publication{projectTotal === 1 ? '' : 's'} in this project
              </CountPill>
            ) : null}
            <InfoBox icon={<IconHelpCircle />} className="mb-4">
              <p className="text-text-muted">
                Want to import a database export? Go to <Link to={`/projects/${projectId}/imports`}>Searches and Imports</Link>.
              </p>
            </InfoBox>
            {query.error ? <p className="text-danger" role="alert">{query.error.message}</p> : null}
            {query.data ? (
              <div className="flex flex-wrap items-center gap-3">
                <label className="w-full flex-[0_1_32rem]">
                  Search publications
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => narrow(setSearch)(event.target.value)}
                    placeholder="Title, author, DOI, keyword…"
                  />
                </label>
                <FieldLabel>
                  Title/Abstract stage
                  <Select value={titleAbstractFilter} onChange={(event) => narrow(setTitleAbstractFilter)(event.target.value)}>
                    {SCREENING_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </FieldLabel>
                <FieldLabel>
                  Full-text stage
                  <Select value={fullTextFilter} onChange={(event) => narrow(setFullTextFilter)(event.target.value)}>
                    {SCREENING_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </FieldLabel>
                <FieldLabel>
                  PDF status
                  <Select value={pdfStatusFilter} onChange={(event) => narrow(setPdfStatusFilter)(event.target.value)}>
                    {PDF_STATUS_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </FieldLabel>
                <button
                  type="button"
                  className={cn(
                    'inline-flex min-h-11 w-fit items-center gap-2 self-end rounded-full border bg-none px-[11px] py-1.5 text-[0.82rem] font-bold shadow-none transition-colors hover:not-disabled:border-primary hover:not-disabled:bg-primary-container-hover hover:not-disabled:text-primary [&_svg]:size-4 [&_svg]:fill-current',
                    missingPdfCount
                      ? 'border-[color-mix(in_srgb,var(--color-warning)_32%,var(--color-border))] bg-warning-container text-warning'
                      : 'border-[color-mix(in_srgb,var(--color-success)_28%,var(--color-border))] bg-success-container text-success',
                    pdfStatusFilter === 'unavailable' && 'border-primary bg-primary-container text-primary shadow-[inset_0_0_0_1px_var(--color-primary)]',
                  )}
                  aria-pressed={pdfStatusFilter === 'unavailable'}
                  disabled={missingPdfCount === 0}
                  onClick={() => narrow(setPdfStatusFilter)(
                    pdfStatusFilter === 'unavailable' ? '' : 'unavailable',
                  )}
                >
                  <IconUpload />
                  {missingPdfCount
                    ? `${missingPdfCount} paper${missingPdfCount === 1 ? '' : 's'} missing a PDF`
                    : 'All papers have a PDF'}
                </button>
                <label className="hidden max-[900px]:block">
                  Sort by
                  <Select
                    value={`${sortKey}:${sortDirection}`}
                    onChange={(event) => {
                      const [key, direction] = event.target.value.split(':') as [PublicationSortKey, SortDirection]
                      setSortKey(key)
                      setSortDirection(direction)
                      setPage(1)
                    }}
                  >
                    <option value="title:asc">Title A–Z</option>
                    <option value="title:desc">Title Z–A</option>
                    <option value="authors:asc">Authors A–Z</option>
                    <option value="authors:desc">Authors Z–A</option>
                    <option value="year:desc">Newest publication year</option>
                    <option value="year:asc">Oldest publication year</option>
                    <option value="source:asc">Source A–Z</option>
                    <option value="source:desc">Source Z–A</option>
                    <option value="stage:asc">Stage A–Z</option>
                    <option value="stage:desc">Stage Z–A</option>
                    <option value="pdf:desc">PDF available first</option>
                    <option value="pdf:asc">PDF missing first</option>
                  </Select>
                </label>
              </div>
            ) : null}
            {canManage && publications.length > 0 ? (
              <div className={`${toolbarClass} publication-list__bulk-actions`}>
                <FieldLabel inline>
                  <Input
                    type="checkbox"
                    checked={allPageSelected}
                    onChange={toggleSelectPage}
                  />
                  {' '}Select All ({publications.length})
                </FieldLabel>
                {total > publications.length ? (
                  <Button
                    type="button"
                    variant="text"
                    size="sm"
                    disabled={selectAllMatching.isPending}
                    onClick={() => selectAllMatching.mutate()}
                  >
                    Select all {total} matching
                  </Button>
                ) : null}
                {selectedIds.size > 0 ? (
                  <>
                    <span className="text-text-muted">{selectedIds.size} selected</span>
                    <Button
                      type="button"
                      variant="text"
                      size="sm"
                      onClick={() => setSelectedIds(new Set())}
                    >
                      Clear selection
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={bulkEnrich.isPending}
                      onClick={() => bulkEnrich.mutate({ publicationIds: Array.from(selectedIds), missingOnly: false })}
                    >
                      <IconSparkle />
                      Enrich Selected Metadata ({selectedIds.size})
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={bulkExport.isPending || (pendingExportJob ? isJobActive(pendingExportJob.status) : false)}
                      onClick={() => bulkExport.mutate(Array.from(selectedIds))}
                    >
                      <IconDownload />
                      Export Selected ({selectedIds.size})
                    </Button>
                    <ConfirmButton
                      size="sm"
                      label={`Delete Selected (${selectedIds.size})`}
                      variant="danger"
                      warning={`Delete ${selectedIds.size} selected publication${selectedIds.size === 1 ? '' : 's'}? This cannot be undone.`}
                      onConfirm={() => bulkDelete.mutate(Array.from(selectedIds))}
                      disabled={bulkDelete.isPending}
                      icon={<IconTrash />}
                    />
                  </>
                ) : null}
              </div>
            ) : null}
            {selectAllMatching.error ? <p className="text-danger" role="alert">{selectAllMatching.error.message}</p> : null}
            {bulkEnrich.error ? <p className="text-danger" role="alert">{bulkEnrich.error.message}</p> : null}
            {bulkEnrich.isSuccess ? <p>Enrichment queued for {bulkEnrich.data.jobIds.length} publication{bulkEnrich.data.jobIds.length === 1 ? '' : 's'}.</p> : null}
            {bulkDelete.error ? <p className="text-danger" role="alert">{bulkDelete.error.message}</p> : null}
            {bulkExport.error ? <p className="text-danger" role="alert">{bulkExport.error.message}</p> : null}
            {pendingExportJob && isJobActive(pendingExportJob.status) ? (
              <p className="text-text-muted" role="status">Preparing export bundle (metadata.bib + PDFs)…</p>
            ) : null}
            {pendingExportJob && pendingExportJob.status === 'failed' ? (
              <p className="text-danger" role="alert">
                Export failed{pendingExportJob.errorMessage ? `: ${pendingExportJob.errorMessage}` : ''}
              </p>
            ) : null}
            {pendingExportJob && pendingExportJob.status === 'completed' && typeof exportArtifactId === 'string' ? (
              <p>
                Export ready:{' '}
                <a href={`/api/v1/projects/${projectId}/exports/${exportArtifactId}/download`}>
                  Download bundle
                </a>
              </p>
            ) : null}
            <PaginationSummary
              className="mt-6"
              noun="publication"
              page={page}
              pageSize={pageSize}
              itemCount={publications.length}
              total={total}
            />
            <div className={cn(publicationRowGridClass, 'mt-6 mb-2 px-4 text-[0.72rem] font-bold tracking-[0.04em] text-text-muted uppercase max-[900px]:hidden')}>
              <span aria-hidden="true" />
              <span className="flex items-center gap-0.5">
                <PublicationListSortHeader label="Title" sortKey="title" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />{' / '}
                <PublicationListSortHeader label="Authors" sortKey="authors" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
              </span>
              <PublicationListSortHeader label="Year" sortKey="year" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
              <PublicationListSortHeader label="Source" sortKey="source" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
              <PublicationListSortHeader label="Stage" sortKey="stage" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
              <PublicationListSortHeader label="PDF" sortKey="pdf" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
              <span aria-hidden="true" />
            </div>
            <ul ref={tableTopRef} className="m-0 grid list-none gap-2 p-0 scroll-mt-[92px]">
              {publications.map((publication) => (
                <PublicationRow
                  key={publication.id}
                  publication={publication}
                  projectId={projectId}
                  selected={selectedIds.has(publication.id)}
                  onToggleSelected={() => toggleSelected(publication.id)}
                  highlightKeywords={highlightKeywords}
                  canManage={canManage}
                />
              ))}
            </ul>
            {query.data && publications.length === 0 ? (
              <p className="text-text-muted">
                {filtersActive
                  ? 'No publications match your filters.'
                  : 'No publications yet.'}
              </p>
            ) : null}
            {publications.length > 0 ? (
              <PaginationControls
                label="Publication pages"
                page={page}
                pageCount={pageCount}
                pageSize={pageSize}
                onPageChange={goToPage}
                onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
              />
            ) : null}
          </div>
        ) : null}
        {activeTab === 'add' ? (
          <AddPublicationForm projectId={projectId} />
        ) : null}
        {activeTab === 'metadata' && canManage ? (
          <>
            <section className={cn(cardStyles, 'scroll-mt-[92px]')} data-ui="card" id="section-metadata-enrichment">
              <h2>Metadata Enrichment</h2>
              <p className="text-text-muted">
                Fill in missing metadata from Crossref and Semantic Scholar for every record missing metadata.
                <InfoTooltip text="Crossref and Semantic Scholar are free external scholarly databases. This looks up each publication there by DOI or title and fills in fields like abstract, venue, or citation count that are missing here — it doesn't overwrite fields you've already filled in." />
              </p>
              {bulkEnrich.error ? <p className="text-danger" role="alert">{bulkEnrich.error.message}</p> : null}
              {bulkEnrich.isSuccess ? <p>Enrichment queued for {bulkEnrich.data.jobIds.length} publication{bulkEnrich.data.jobIds.length === 1 ? '' : 's'}.</p> : null}
              <div className={toolbarClass}>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={bulkEnrich.isPending}
                  onClick={() => bulkEnrich.mutate({ missingOnly: true })}
                >
                  <IconSparkle />
                  Enrich All Records with Missing Metadata
                </Button>
              </div>
            </section>
            <MetadataConflictsPanel projectId={projectId} />
          </>
        ) : null}
        {activeTab === 'pdf_retrieval' ? (
          <>
            <BrowserPdfRetrievalPanel projectId={projectId} />
            {canManage ? <BulkPdfUploadPanel projectId={projectId} /> : null}
          </>
        ) : null}
      </TabPanel>
    </Page>
  )
}
