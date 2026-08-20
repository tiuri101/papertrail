import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CountPill } from '../../components/CountPill'
import { HighlightedText } from '../../components/HighlightedText'
import {
  IconCheckCircle,
  IconDownload,
  IconEye,
  IconFolder,
  IconPlus,
  IconSparkle,
  IconTrash,
  IconUpload,
} from '../../components/icons'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { RowActionsMenu } from '../../components/RowActionsMenu'
import { InfoTooltip } from '../../components/Tooltip'
import { FullTextDocumentPanel } from '../fulltext/FullTextDocumentPanel'
import { AdministrationEyebrow } from '../projects/StageEyebrow'
import { useCanManagePublications } from '../../hooks/useCanManageProject'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'
import { BrowserPdfRetrievalPanel } from '../fulltext/BrowserPdfRetrievalPanel'
import { AddPublicationForm } from './AddPublicationPage'
import { BulkPdfUploadPanel } from './BulkPdfUploadPanel'
import { PublicationFieldInputs } from './publicationFields'
import { PublicationDraft, toPayload } from './publicationFieldsData'
import {
  primaryStage,
  sortPublications,
  type Publication,
  type PublicationSortKey,
  type SortDirection,
} from './publicationShared'

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

function matchesScreeningFilter(outcome: string | null | undefined, filter: string): boolean {
  if (!filter) return true
  return (outcome ?? 'pending') === filter
}

function matchesPdfStatusFilter(available: boolean, filter: string): boolean {
  if (!filter) return true
  return filter === 'available' ? available : !available
}

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
    <form onSubmit={(event) => { event.preventDefault(); update.mutate() }}>
      <PublicationFieldInputs draft={draft} setField={setField} />
      {update.error ? <p className="error" role="alert">{update.error.message}</p> : null}
      <div className="toolbar">
        <button type="submit" disabled={update.isPending}><IconCheckCircle />Save</button>
        <button type="button" className="button-secondary" onClick={onDone}>Cancel</button>
      </div>
    </form>
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
    <li className={`card publication-card${canManage ? ' publication-card--manageable' : ''}${selected ? ' publication-card--selected' : ''}`}>
      <div className="publication-card__summary publication-row-grid">
        <span className="publication-row-grid__checkbox">
          {canManage ? (
            <input
              className="publication-card__checkbox"
              type="checkbox"
              checked={selected}
              onChange={onToggleSelected}
              aria-label={`Select ${publication.title}`}
            />
          ) : null}
        </span>
        <div className="publication-row-grid__title">
          <Link className="publication-card__title-button" to={detailHref}>
            <strong><HighlightedText text={publication.title} keywords={highlightKeywords} /></strong>
          </Link>
          <div className="publication-row-grid__authors">{publication.authors ?? 'Unknown authors'}</div>
        </div>
        <span className="publication-row-grid__year">{publication.publicationYear ?? '—'}</span>
        <span className="publication-row-grid__source" title={publication.venue ?? undefined}>
          {publication.venue ?? '—'}
        </span>
        <span className="publication-row-grid__stage">
          <span className={`status-badge ${stage.className}`}>{stage.label}</span>
        </span>
        <span className="publication-row-grid__pdf">
          <PdfAvailabilityPill
            available={Boolean(publication.fullText?.available)}
            href={`/api/v1/projects/${projectId}/publications/${publication.id}/full-text/content`}
            pageCount={publication.fullText?.document?.pageCount}
            compact
          />
        </span>
        <span className="publication-row-grid__actions">
          <Link
            className="icon-button"
            to={detailHref}
            aria-label={`View ${publication.title}`}
            title="View details"
          >
            <IconEye />
          </Link>
          {canManage ? (
            <RowActionsMenu label={`More actions for ${publication.title}`}>
              <Link className="row-actions-menu__item" to={`${detailHref}?edit=1`}>Edit Metadata</Link>
              <button
                type="button"
                className="row-actions-menu__item"
                onClick={() => enrich.mutate()}
                disabled={enrich.isPending || !publication.doi}
              >
                Enrich Metadata
              </button>
              <button
                type="button"
                className="row-actions-menu__item"
                onClick={() => setShowFullText((current) => !current)}
              >
                {showFullText ? 'Hide PDF' : publication.fullText?.available ? 'Manage PDF' : 'Attach PDF'}
              </button>
              <a className="row-actions-menu__item" href={`/api/v1/projects/${projectId}/publications/${publication.id}/export/bib`}>
                Export BibTeX
              </a>
              {publication.fullText?.available ? (
                <a className="row-actions-menu__item" href={`/api/v1/projects/${projectId}/publications/${publication.id}/export/pdf`}>
                  Export PDF
                </a>
              ) : null}
              <ConfirmButton
                label="Delete"
                variant="danger"
                className="row-actions-menu__item row-actions-menu__item--danger"
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
      {enrich.isSuccess ? <p className="muted publication-row__message">Enrichment queued.</p> : null}
      {enrich.error ? <p className="error" role="alert">{enrich.error.message}</p> : null}
      {remove.error ? <p className="error" role="alert">{remove.error.message}</p> : null}
    </li>
  )
}

function MetadataConflictsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const conflicts = useQuery({
    queryKey: ['metadata-conflicts', projectId],
    queryFn: () => apiRequest<MetadataConflict[]>(
      `/api/v1/projects/${projectId}/metadata-conflicts`,
    ),
  })

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

  useEffect(() => {
    if (!conflicts.data?.length || window.location.hash !== '#metadata-conflicts') return
    document.getElementById('metadata-conflicts')?.scrollIntoView({ block: 'start' })
  }, [conflicts.data])

  if (!conflicts.error && (!conflicts.data || conflicts.data.length === 0)) return null

  return (
    <section className="card metadata-conflicts" id="metadata-conflicts">
      <h2>Metadata Conflicts</h2>
      <p className="muted">Enrichment or a duplicate merge proposed a different value for a field that already had one. Review each side by side and choose which value to keep.</p>
      {conflicts.error ? <p className="error" role="alert">{conflicts.error.message}</p> : null}
      {resolve.error ? <p className="error" role="alert">{resolve.error.message}</p> : null}
      <ul className="metadata-conflict-list">
        {conflicts.data?.map((conflict) => (
          <li key={conflict.id} className="metadata-conflict-card">
            <header className="metadata-conflict-card__header">
              <div>
                <span className="eyebrow">Metadata conflict</span>
                <h3>{conflict.publication?.title ?? conflict.currentValue ?? 'Publication'}</h3>
              </div>
              <span className="metadata-conflict-card__source">
                Proposed by {metadataSourceLabel(conflict.sourceName)}
              </span>
            </header>
            <div className="metadata-conflict-comparison">
              <section className="metadata-conflict-value metadata-conflict-value--current">
                <header>
                  <span className="metadata-conflict-value__label" aria-hidden="true">A</span>
                  <div>
                    <h4>Current Value</h4>
                    <p>{humanizeMetadataField(conflict.fieldName)}</p>
                  </div>
                </header>
                <div className="metadata-conflict-value__content">
                  {conflict.currentValue ?? <span className="muted">(empty)</span>}
                </div>
              </section>
              <aside className="metadata-conflict-reason">
                <span className="metadata-conflict-reason__icon" aria-hidden="true">
                  <IconSparkle />
                </span>
                <h4>Why was this proposed?</h4>
                <p>{metadataConflictExplanation(conflict)}</p>
              </aside>
              <section className="metadata-conflict-value metadata-conflict-value--proposed">
                <header>
                  <span className="metadata-conflict-value__label" aria-hidden="true">B</span>
                  <div>
                    <h4>Proposed Value</h4>
                    <p>{humanizeMetadataField(conflict.fieldName)}</p>
                  </div>
                </header>
                <div className="metadata-conflict-value__content">
                  {conflict.proposedValue ?? <span className="muted">(empty)</span>}
                </div>
              </section>
            </div>
            {conflict.publication ? (
              <details className="metadata-conflict-card__details">
                <summary>All publication metadata</summary>
                <dl className="detail-list metadata-conflict__metadata">
                  {PUBLICATION_METADATA_FIELDS.map((field) => {
                    const value = field.value(conflict.publication!)
                    return (
                      <div key={field.label} className="detail-list__row">
                        <dt>{field.label}</dt>
                        <dd>{value || <span className="muted">(empty)</span>}</dd>
                      </div>
                    )
                  })}
                </dl>
              </details>
            ) : null}
            <section className="metadata-conflict-decision">
              <div>
                <h4>Your Decision</h4>
                <p>Choose which value Papertrail should keep for this publication.</p>
              </div>
              <div className="metadata-conflict-decision__actions">
              <button
                type="button"
                className="metadata-conflict-decision__option metadata-conflict-decision__option--current"
                aria-label="Keep Current Value"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ conflictId: conflict.id, acceptProposed: false })}
              >
                <span className="metadata-conflict-decision__marker" aria-hidden="true" />
                <span>
                  <strong>Keep Current Value</strong>
                  <small>Retain Value A</small>
                </span>
              </button>
              <button
                type="button"
                className="metadata-conflict-decision__option metadata-conflict-decision__option--proposed"
                aria-label="Use Proposed Value"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ conflictId: conflict.id, acceptProposed: true })}
              >
                <span className="metadata-conflict-decision__marker"><IconCheckCircle /></span>
                <span>
                  <strong>Use Proposed Value</strong>
                  <small>Replace it with Value B</small>
                </span>
              </button>
              </div>
            </section>
          </li>
        ))}
      </ul>
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
  const query = useQuery({
    queryKey: ['publications', projectId],
    queryFn: () => apiRequest<Publication[]>(
      `/api/v1/projects/${projectId}/publications`,
    ),
  })

  const filteredPublications = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    return (query.data ?? []).filter((publication) => {
      const searchableMetadata = [
        publication.title,
        publication.authors,
        publication.abstract,
        publication.publicationYear,
        publication.venue,
        publication.publicationType,
        publication.doi,
        publication.publisherUrl,
        publication.keywords,
        publication.isbn,
        publication.issn,
        publication.pubmedId,
        publication.arxivId,
      ].filter((value) => value !== null && value !== undefined).join(' ').toLocaleLowerCase()
      return (!normalizedSearch || searchableMetadata.includes(normalizedSearch))
        && matchesScreeningFilter(publication.screeningStatus?.titleAbstract, titleAbstractFilter)
        && matchesScreeningFilter(publication.screeningStatus?.fullText, fullTextFilter)
        && matchesPdfStatusFilter(Boolean(publication.fullText?.available), pdfStatusFilter)
    })
  }, [query.data, search, titleAbstractFilter, fullTextFilter, pdfStatusFilter])

  const sortedPublications = useMemo(
    () => sortPublications(filteredPublications, sortKey, sortDirection),
    [filteredPublications, sortKey, sortDirection],
  )

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

  const allFilteredSelected = filteredPublications.length > 0
    && filteredPublications.every((publication) => selectedIds.has(publication.id))
  const missingPdfCount = query.data?.filter(
    (publication) => !publication.fullText.available,
  ).length ?? 0

  const toggleSelectAll = () => setSelectedIds((current) => {
    const next = new Set(current)
    if (allFilteredSelected) {
      filteredPublications.forEach((publication) => next.delete(publication.id))
    } else {
      filteredPublications.forEach((publication) => next.add(publication.id))
    }
    return next
  })

  const visibleTabs = publicationsTabs.filter((tab) => tab.id !== 'metadata' || canManage)

  return (
    <main className="page">
      <AdministrationEyebrow />
      <h1>Publications</h1>
      <p className="muted">
        Want to import a database export? Go to <Link to={`/projects/${projectId}/imports`}>Searches and Imports</Link>.
      </p>
      <div className="page-tabs" role="tablist" aria-label="Publications sections">
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`publications-tab-${tab.id}`}
            aria-selected={tab.id === activeTab}
            aria-controls={`publications-tabpanel-${tab.id}`}
            className={`page-tab${tab.id === activeTab ? ' page-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`publications-tabpanel-${activeTab}`}
        className="page-tabpanel"
        role="tabpanel"
        aria-labelledby={`publications-tab-${activeTab}`}
      >
        {activeTab === 'publications' ? (
          <>
            {query.data && (search || titleAbstractFilter || fullTextFilter || pdfStatusFilter) ? (
              <CountPill count={filteredPublications.length}>
                of {query.data.length} publications match your filters
              </CountPill>
            ) : query.data ? (
              <CountPill count={query.data.length}>
                publication{query.data.length === 1 ? '' : 's'} in this project
              </CountPill>
            ) : null}
            {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
            {query.data ? (
              <div className="toolbar publications-page__filters">
                <label className="paper-search-field">
                  Search publications
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Title, author, DOI, keyword…"
                  />
                </label>
                <label>
                  Title/Abstract stage
                  <select value={titleAbstractFilter} onChange={(event) => setTitleAbstractFilter(event.target.value)}>
                    {SCREENING_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Full-text stage
                  <select value={fullTextFilter} onChange={(event) => setFullTextFilter(event.target.value)}>
                    {SCREENING_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  PDF status
                  <select value={pdfStatusFilter} onChange={(event) => setPdfStatusFilter(event.target.value)}>
                    {PDF_STATUS_FILTER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={`publications-page__pdf-indicator${missingPdfCount ? ' publications-page__pdf-indicator--missing' : ''}${pdfStatusFilter === 'unavailable' ? ' publications-page__pdf-indicator--active' : ''}`}
                  aria-pressed={pdfStatusFilter === 'unavailable'}
                  disabled={missingPdfCount === 0}
                  onClick={() => setPdfStatusFilter((current) => (
                    current === 'unavailable' ? '' : 'unavailable'
                  ))}
                >
                  <IconUpload />
                  {missingPdfCount
                    ? `${missingPdfCount} paper${missingPdfCount === 1 ? '' : 's'} missing a PDF`
                    : 'All papers have a PDF'}
                </button>
                <label>
                  Sort by
                  <select
                    value={`${sortKey}:${sortDirection}`}
                    onChange={(event) => {
                      const [key, direction] = event.target.value.split(':') as [PublicationSortKey, SortDirection]
                      setSortKey(key)
                      setSortDirection(direction)
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
                  </select>
                </label>
              </div>
            ) : null}
            {canManage && filteredPublications.length > 0 ? (
              <div className="toolbar publication-list__bulk-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                  />
                  {' '}Select All ({filteredPublications.length})
                </label>
                {selectedIds.size > 0 ? (
                  <>
                    <span className="muted">{selectedIds.size} selected</span>
                    <button
                      type="button"
                      className="button-secondary button-sm"
                      disabled={bulkEnrich.isPending}
                      onClick={() => bulkEnrich.mutate({ publicationIds: Array.from(selectedIds), missingOnly: false })}
                    >
                      <IconSparkle />
                      Enrich Selected Metadata ({selectedIds.size})
                    </button>
                    <button
                      type="button"
                      className="button-secondary button-sm"
                      disabled={bulkExport.isPending || (pendingExportJob ? isJobActive(pendingExportJob.status) : false)}
                      onClick={() => bulkExport.mutate(Array.from(selectedIds))}
                    >
                      <IconDownload />
                      Export Selected ({selectedIds.size})
                    </button>
                    <ConfirmButton
                      className="button-sm"
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
            {bulkEnrich.error ? <p className="error" role="alert">{bulkEnrich.error.message}</p> : null}
            {bulkEnrich.isSuccess ? <p>Enrichment queued for {bulkEnrich.data.jobIds.length} publication{bulkEnrich.data.jobIds.length === 1 ? '' : 's'}.</p> : null}
            {bulkDelete.error ? <p className="error" role="alert">{bulkDelete.error.message}</p> : null}
            {bulkExport.error ? <p className="error" role="alert">{bulkExport.error.message}</p> : null}
            {pendingExportJob && isJobActive(pendingExportJob.status) ? (
              <p className="muted" role="status">Preparing export bundle (metadata.bib + PDFs)…</p>
            ) : null}
            {pendingExportJob && pendingExportJob.status === 'failed' ? (
              <p className="error" role="alert">
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
            <ul className="card-list stacked publication-list">
              {sortedPublications.map((publication) => (
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
          </>
        ) : null}
        {activeTab === 'add' ? (
          <AddPublicationForm projectId={projectId} />
        ) : null}
        {activeTab === 'metadata' && canManage ? (
          <>
            <section className="card" id="section-metadata-enrichment">
              <h2>Metadata Enrichment</h2>
              <p className="muted">
                Fill in missing metadata from Crossref and Semantic Scholar for every record missing metadata.
                <InfoTooltip text="Crossref and Semantic Scholar are free external scholarly databases. This looks up each publication there by DOI or title and fills in fields like abstract, venue, or citation count that are missing here — it doesn't overwrite fields you've already filled in." />
              </p>
              {bulkEnrich.error ? <p className="error" role="alert">{bulkEnrich.error.message}</p> : null}
              {bulkEnrich.isSuccess ? <p>Enrichment queued for {bulkEnrich.data.jobIds.length} publication{bulkEnrich.data.jobIds.length === 1 ? '' : 's'}.</p> : null}
              <div className="toolbar">
                <button
                  type="button"
                  className="button-secondary button-md"
                  disabled={bulkEnrich.isPending}
                  onClick={() => bulkEnrich.mutate({ missingOnly: true })}
                >
                  <IconSparkle />
                  Enrich All Records with Missing Metadata
                </button>
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
      </div>
    </main>
  )
}
