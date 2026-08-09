import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { HighlightedText } from '../../components/HighlightedText'
import { FullTextDocumentPanel } from '../fulltext/FullTextDocumentPanel'
import { useCanManageProject } from '../../hooks/useCanManageProject'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { BulkPdfUploadPanel } from './BulkPdfUploadPanel'
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
  fullText: { available: boolean }
  screeningStatus?: ScreeningStatus
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
        <button type="submit" disabled={update.isPending}>Save</button>
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
          {publication.fullText?.available ? <span className="status-badge"> PDF ✓</span> : null}
          <span className="status-badge"> · Title/Abstract: {screeningLabel(publication.screeningStatus?.titleAbstract)}</span>
          {publication.screeningStatus?.fullText || publication.screeningStatus?.titleAbstract === 'include' ? (
            <span className="status-badge"> · Full text: {screeningLabel(publication.screeningStatus?.fullText)}</span>
          ) : null}
          {publication.doi ? (
            <> <a href={`https://doi.org/${publication.doi}`} target="_blank" rel="noopener noreferrer">DOI</a></>
          ) : null}
          {isSafeHttpUrl(publication.publisherUrl) ? (
            <> <a href={publication.publisherUrl} target="_blank" rel="noopener noreferrer">Publisher link</a></>
          ) : null}
        </div>
      </div>
      <details className="publication-card__abstract">
        <summary>Abstract</summary>
        <p>{publication.abstract?.trim() || 'No abstract available.'}</p>
      </details>
      {canManage ? (
        <div className="toolbar publication-card__actions">
          <button type="button" className="button-secondary" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" onClick={() => enrich.mutate()} disabled={enrich.isPending || !publication.doi}>
            Enrich Metadata
          </button>
          <button type="button" className="button-secondary" onClick={() => setShowFullText((current) => !current)}>
            {showFullText ? 'Hide PDF' : publication.fullText?.available ? 'Manage PDF' : 'Attach PDF'}
          </button>
          <ConfirmButton
            label="Delete"
            variant="danger"
            warning={`Delete "${publication.title}"? This cannot be undone.`}
            onConfirm={() => remove.mutate()}
            disabled={remove.isPending}
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
            <strong>{conflict.fieldName}</strong> — proposed by {conflict.sourceName}
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
            <div className="toolbar">
              <button
                type="button"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ conflictId: conflict.id, acceptProposed: true })}
              >
                Use Proposed Value
              </button>
              <button
                type="button"
                className="button-secondary"
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

export function PublicationsPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const canManage = useCanManageProject(projectId)
  const highlightKeywords = useHighlightKeywords(projectId)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [titleAbstractFilter, setTitleAbstractFilter] = useState('')
  const [fullTextFilter, setFullTextFilter] = useState('')
  const [pdfStatusFilter, setPdfStatusFilter] = useState('')
  const query = useQuery({
    queryKey: ['publications', projectId],
    queryFn: () => apiRequest<Publication[]>(
      `/api/v1/projects/${projectId}/publications`,
    ),
  })

  const filteredPublications = useMemo(() => (
    (query.data ?? []).filter((publication) => (
      matchesScreeningFilter(publication.screeningStatus?.titleAbstract, titleAbstractFilter)
      && matchesScreeningFilter(publication.screeningStatus?.fullText, fullTextFilter)
      && matchesPdfStatusFilter(Boolean(publication.fullText?.available), pdfStatusFilter)
    ))
  ), [query.data, titleAbstractFilter, fullTextFilter, pdfStatusFilter])

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

  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const allFilteredSelected = filteredPublications.length > 0
    && filteredPublications.every((publication) => selectedIds.has(publication.id))

  const toggleSelectAll = () => setSelectedIds((current) => {
    const next = new Set(current)
    if (allFilteredSelected) {
      filteredPublications.forEach((publication) => next.delete(publication.id))
    } else {
      filteredPublications.forEach((publication) => next.add(publication.id))
    }
    return next
  })

  return (
    <main className="page">
      <h1>Publications</h1>
      {query.data && (titleAbstractFilter || fullTextFilter || pdfStatusFilter) ? (
        <p className="muted">
          {filteredPublications.length} of {query.data.length} publication{query.data.length === 1 ? '' : 's'} match your filters
        </p>
      ) : query.data ? (
        <p className="muted">{query.data.length} publication{query.data.length === 1 ? '' : 's'} in this project</p>
      ) : null}
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {canManage ? (
        <CollapsibleSection
          id="section-metadata-enrichment"
          title="Metadata Enrichment"
          defaultExpanded={false}
        >
          <p className="muted">Fill in missing metadata from Crossref and Semantic Scholar for one record, a selection, or every record missing metadata.</p>
          {bulkEnrich.error ? <p className="error" role="alert">{bulkEnrich.error.message}</p> : null}
          {bulkEnrich.isSuccess ? <p>Enrichment queued for {bulkEnrich.data.jobIds.length} publication{bulkEnrich.data.jobIds.length === 1 ? '' : 's'}.</p> : null}
          <div className="toolbar">
            <button
              type="button"
              disabled={bulkEnrich.isPending || selectedIds.size === 0}
              onClick={() => bulkEnrich.mutate({ publicationIds: Array.from(selectedIds), missingOnly: false })}
            >
              Enrich Selected ({selectedIds.size})
            </button>
            <button
              type="button"
              disabled={bulkEnrich.isPending}
              onClick={() => bulkEnrich.mutate({ missingOnly: true })}
            >
              Enrich All Records with Missing Metadata
            </button>
          </div>
        </CollapsibleSection>
      ) : null}
      {canManage ? <MetadataConflictsPanel projectId={projectId} /> : null}
      {canManage ? <BulkPdfUploadPanel projectId={projectId} /> : null}
      {query.data ? (
        <div className="toolbar">
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
              <ConfirmButton
                label={`Delete Selected (${selectedIds.size})`}
                variant="danger"
                warning={`Delete ${selectedIds.size} selected publication${selectedIds.size === 1 ? '' : 's'}? This cannot be undone.`}
                onConfirm={() => bulkDelete.mutate(Array.from(selectedIds))}
                disabled={bulkDelete.isPending}
              />
            </>
          ) : null}
        </div>
      ) : null}
      {bulkDelete.error ? <p className="error" role="alert">{bulkDelete.error.message}</p> : null}
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
          />
        ))}
      </ul>
    </main>
  )
}
