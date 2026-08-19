import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { HighlightedText } from '../../components/HighlightedText'
import {
  IconCheckCircle,
  IconClock,
  IconDownload,
  IconFolder,
  IconPlus,
  IconSparkle,
  IconTrash,
  IconUpload,
  IconXCircle,
} from '../../components/icons'
import { DoiPill } from '../../components/DoiPill'
import { OutcomeBadge } from '../../components/OutcomeBadge'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { InfoTooltip } from '../../components/Tooltip'
import { FullTextDocumentPanel } from '../fulltext/FullTextDocumentPanel'
import { AdministrationEyebrow } from '../projects/StageEyebrow'
import { useCanManageProject, useCanManagePublications } from '../../hooks/useCanManageProject'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { BrowserPdfRetrievalPanel } from '../fulltext/BrowserPdfRetrievalPanel'
import { AddPublicationForm } from './AddPublicationPage'
import { BulkPdfUploadPanel } from './BulkPdfUploadPanel'
import { PublicationReviewDetails } from './PublicationReviewDetails'
import { PublicationFieldInputs } from './publicationFields'
import { PublicationDraft, toPayload } from './publicationFieldsData'

interface ScreeningStatus {
  titleAbstract: string | null
  fullText: string | null
}

interface Publication {
  id: string
  title: string
  authors: string | null
  abstract: string | null
  publicationYear: number | null
  venue: string | null
  publicationType: string | null
  doi: string | null
  publisherUrl: string | null
  keywords: string | null
  isbn: string | null
  issn: string | null
  pubmedId: string | null
  arxivId: string | null
  fullText: {
    available: boolean
    retrievalStatus?: string | null
    document?: { pageCount: number | null } | null
  }
  screeningStatus?: ScreeningStatus
  extractionStatus?: string | null
}

const SCREENING_OUTCOME_LABELS: Record<string, string> = {
  include: 'Included',
  exclude: 'Excluded',
  uncertain: 'Uncertain',
  duplicate: 'Duplicate',
}

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

function screeningLabel(outcome: string | null | undefined): string {
  if (!outcome) return 'Pending'
  return SCREENING_OUTCOME_LABELS[outcome] ?? outcome
}

// Full-text screening is skipped entirely when retrieval definitively fails
// (see backend/app/screening/routes.py), so those publications never get a
// screening decision and would otherwise be mislabeled "Pending" forever.
const FULL_TEXT_RETRIEVAL_FAILURE_LABELS: Record<string, string> = {
  not_found: 'Not found',
  inaccessible: 'Inaccessible',
}

function fullTextRetrievalFailureLabel(retrievalStatus: string | null | undefined): string | null {
  if (!retrievalStatus) return null
  return FULL_TEXT_RETRIEVAL_FAILURE_LABELS[retrievalStatus] ?? null
}

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

function PublicationEditForm({
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
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

function extractionLabel(status: string): string {
  if (status === 'completed') return 'Completed'
  if (status === 'reserved') return 'In progress'
  if (status === 'available') return 'Pending'
  return status.replaceAll('_', ' ')
}

function extractionBadgeClass(status: string): string {
  if (status === 'completed') return 'status-badge--success'
  if (status === 'reserved') return 'status-badge--warning'
  return 'status-badge--pending'
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

function PublicationRow({
  publication,
  projectId,
  selected,
  onToggleSelected,
  highlightKeywords,
  canManage,
  canOverride,
}: {
  publication: Publication
  projectId: string
  selected: boolean
  onToggleSelected: () => void
  highlightKeywords: string[]
  canManage: boolean
  canOverride: boolean
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
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

  if (editing && canManage) {
    return (
      <li className="card">
        <PublicationEditForm publication={publication} projectId={projectId} onDone={() => setEditing(false)} />
      </li>
    )
  }

  return (
    <li className={`card publication-card${canManage ? ' publication-card--manageable' : ''}${selected ? ' publication-card--selected' : ''}`}>
      <div className="publication-card__summary">
        {canManage ? (
          <input
            className="publication-card__checkbox"
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`Select ${publication.title}`}
          />
        ) : null}
        <div>
          {canManage ? (
            <button type="button" className="link-button" onClick={() => setEditing(true)}>
              <strong><HighlightedText text={publication.title} keywords={highlightKeywords} /></strong>
            </button>
          ) : (
            <strong><HighlightedText text={publication.title} keywords={highlightKeywords} /></strong>
          )}
          {' — '}{publication.authors ?? 'Unknown authors'}
          {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
        </div>
      </div>
      <div className="publication-card__workflow" aria-label="Review decisions">
        <DoiPill doi={publication.doi} />
        {isSafeHttpUrl(publication.publisherUrl) ? (
          <PublisherLinkPill url={publication.publisherUrl!} />
        ) : null}
        <PdfAvailabilityPill
          available={Boolean(publication.fullText?.available)}
          href={`/api/v1/projects/${projectId}/publications/${publication.id}/full-text/content`}
          pageCount={publication.fullText?.document?.pageCount}
        />
        <OutcomeBadge
          outcome={publication.screeningStatus?.titleAbstract}
          label={`Title/Abstract: ${screeningLabel(publication.screeningStatus?.titleAbstract)}`}
        />
        {publication.screeningStatus?.fullText ? (
          <OutcomeBadge
            outcome={publication.screeningStatus.fullText}
            label={`Full text: ${screeningLabel(publication.screeningStatus.fullText)}`}
          />
        ) : publication.screeningStatus?.titleAbstract === 'include' ? (
          fullTextRetrievalFailureLabel(publication.fullText?.retrievalStatus) ? (
            <span className="status-badge status-badge--danger">
              <IconXCircle />
              Full text: {fullTextRetrievalFailureLabel(publication.fullText?.retrievalStatus)}
            </span>
          ) : (
            <OutcomeBadge outcome={null} label="Full text: Pending" />
          )
        ) : null}
        {publication.extractionStatus ? (
          <span className={`status-badge ${extractionBadgeClass(publication.extractionStatus)}`}>
            {publication.extractionStatus === 'completed' ? <IconCheckCircle /> : <IconClock />}
            Data extraction: {extractionLabel(publication.extractionStatus)}
          </span>
        ) : null}
      </div>
      <details className="publication-card__abstract">
        <summary>Abstract</summary>
        <p>{publication.abstract?.trim() || 'No abstract available.'}</p>
      </details>
      <PublicationReviewDetails
        projectId={projectId}
        publicationId={publication.id}
        canManage={canOverride}
      />
      {canManage ? (
        <div className="toolbar publication-card__actions">
          <button type="button" className="button-secondary button-sm" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" className="button-secondary button-sm" onClick={() => enrich.mutate()} disabled={enrich.isPending || !publication.doi}>
            Enrich Metadata
          </button>
          <button type="button" className="button-secondary button-sm" onClick={() => setShowFullText((current) => !current)}>
            {showFullText ? 'Hide PDF' : publication.fullText?.available ? 'Manage PDF' : 'Attach PDF'}
          </button>
          <a
            className="button-secondary button-sm"
            href={`/api/v1/projects/${projectId}/publications/${publication.id}/export/bib`}
          >
            Export BibTeX
          </a>
          {publication.fullText?.available ? (
            <a
              className="button-secondary"
              href={`/api/v1/projects/${projectId}/publications/${publication.id}/export/pdf`}
            >
              Export PDF
            </a>
          ) : null}
          <ConfirmButton
            label="Delete"
            variant="danger"
            className="button-sm"
            warning={`Delete "${publication.title}"? This cannot be undone.`}
            onConfirm={() => remove.mutate()}
            disabled={remove.isPending}
            icon={<IconTrash />}
          />
        </div>
      ) : null}
      {canManage && showFullText ? (
        <FullTextDocumentPanel
          projectId={projectId}
          publicationId={publication.id}
          onAvailable={refreshPublications}
          onRemoved={refreshPublications}
        />
      ) : null}
      {enrich.isSuccess ? <p className="muted">Enrichment queued.</p> : null}
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

  if (!conflicts.error && (!conflicts.data || conflicts.data.length === 0)) return null

  return (
    <section className="card">
      <h2>Metadata Conflicts</h2>
      <p className="muted">Enrichment or a duplicate merge proposed a different value for a field that already had one. Review each side by side and choose which value to keep.</p>
      {conflicts.error ? <p className="error" role="alert">{conflicts.error.message}</p> : null}
      {resolve.error ? <p className="error" role="alert">{resolve.error.message}</p> : null}
      <ul className="card-list">
        {conflicts.data?.map((conflict) => (
          <li key={conflict.id} className="card">
            <h3>{conflict.publication?.title ?? conflict.currentValue ?? 'Publication'}</h3>
            <p><strong>{conflict.fieldName}</strong> — proposed by {conflict.sourceName}</p>
            <table>
              <thead>
                <tr>
                  <th scope="col">Current value</th>
                  <th scope="col">Proposed value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{conflict.currentValue ?? <span className="muted">(empty)</span>}</td>
                  <td>{conflict.proposedValue ?? <span className="muted">(empty)</span>}</td>
                </tr>
              </tbody>
            </table>
            {conflict.publication ? (
              <details>
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
            <div className="toolbar">
              <button
                type="button"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ conflictId: conflict.id, acceptProposed: true })}
              >
                <IconCheckCircle />
                Use Proposed Value
              </button>
              <button
                type="button"
                className="button-secondary button-sm"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ conflictId: conflict.id, acceptProposed: false })}
              >
                Keep Current Value
              </button>
            </div>
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
  const queryClient = useQueryClient()
  const canManage = useCanManagePublications(projectId)
  const canOverride = useCanManageProject(projectId)
  const highlightKeywords = useHighlightKeywords(projectId)
  const [activeTab, setActiveTab] = useState<PublicationsTabId>('publications')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [pendingExportJobId, setPendingExportJobId] = useState<string | null>(null)
  const [titleAbstractFilter, setTitleAbstractFilter] = useState('')
  const [fullTextFilter, setFullTextFilter] = useState('')
  const [pdfStatusFilter, setPdfStatusFilter] = useState('')
  const [search, setSearch] = useState('')
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
              <p className="muted">
                {filteredPublications.length} of {query.data.length} publication{query.data.length === 1 ? '' : 's'} match your filters
              </p>
            ) : query.data ? (
              <p className="muted">{query.data.length} publication{query.data.length === 1 ? '' : 's'} in this project</p>
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
              {filteredPublications.map((publication) => (
                <PublicationRow
                  key={publication.id}
                  publication={publication}
                  projectId={projectId}
                  selected={selectedIds.has(publication.id)}
                  onToggleSelected={() => toggleSelected(publication.id)}
                  highlightKeywords={highlightKeywords}
                  canManage={canManage}
                  canOverride={canOverride}
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
