import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { HighlightedText } from '../../components/HighlightedText'
import { useCanManageProject } from '../../hooks/useCanManageProject'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'

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
}

interface PublicationDraft {
  title: string
  authors: string
  abstract: string
  publicationYear: string
  venue: string
  publicationType: string
  doi: string
  publisherUrl: string
  keywords: string
  isbn: string
  issn: string
  pubmedId: string
  arxivId: string
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

function toPayload(draft: PublicationDraft) {
  return {
    title: draft.title.trim(),
    authors: draft.authors.trim() || null,
    abstract: draft.abstract.trim() || null,
    publicationYear: draft.publicationYear ? Number(draft.publicationYear) : null,
    venue: draft.venue.trim() || null,
    publicationType: draft.publicationType.trim() || null,
    doi: draft.doi.trim() || null,
    publisherUrl: draft.publisherUrl.trim() || null,
    keywords: draft.keywords.trim() || null,
    isbn: draft.isbn.trim() || null,
    issn: draft.issn.trim() || null,
    pubmedId: draft.pubmedId.trim() || null,
    arxivId: draft.arxivId.trim() || null,
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
      <label>
        Title
        <input value={draft.title} onChange={setField('title')} required />
      </label>
      <label>
        Authors
        <input value={draft.authors} onChange={setField('authors')} />
      </label>
      <label>
        Abstract
        <textarea value={draft.abstract} onChange={setField('abstract')} rows={4} />
      </label>
      <label>
        Year
        <input type="number" value={draft.publicationYear} onChange={setField('publicationYear')} />
      </label>
      <label>
        Venue
        <input value={draft.venue} onChange={setField('venue')} />
      </label>
      <label>
        Publication type
        <input value={draft.publicationType} onChange={setField('publicationType')} />
      </label>
      <label>
        DOI
        <input value={draft.doi} onChange={setField('doi')} />
      </label>
      <label>
        Publisher URL
        <input value={draft.publisherUrl} onChange={setField('publisherUrl')} />
      </label>
      <label>
        Keywords
        <input value={draft.keywords} onChange={setField('keywords')} />
      </label>
      <label>
        ISBN
        <input value={draft.isbn} onChange={setField('isbn')} />
      </label>
      <label>
        ISSN
        <input value={draft.issn} onChange={setField('issn')} />
      </label>
      <label>
        PubMed ID
        <input value={draft.pubmedId} onChange={setField('pubmedId')} />
      </label>
      <label>
        arXiv ID
        <input value={draft.arxivId} onChange={setField('arxivId')} />
      </label>
      {update.error ? <p className="error" role="alert">{update.error.message}</p> : null}
      <div className="toolbar">
        <button type="submit" disabled={update.isPending}>Save</button>
        <button type="button" onClick={onDone}>Cancel</button>
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
    <li className="card">
      <label>
        <input type="checkbox" checked={selected} onChange={onToggleSelected} aria-label={`Select ${publication.title}`} />
      </label>
      {' '}
      {canManage ? (
        <button type="button" className="link-button" onClick={() => setEditing(true)}>
          <strong><HighlightedText text={publication.title} keywords={highlightKeywords} /></strong>
        </button>
      ) : (
        <strong><HighlightedText text={publication.title} keywords={highlightKeywords} /></strong>
      )}
      {' — '}{publication.authors ?? 'Unknown authors'}
      {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
      {publication.doi ? (
        <> <a href={`https://doi.org/${publication.doi}`} target="_blank" rel="noopener noreferrer">DOI</a></>
      ) : null}
      {publication.publisherUrl ? (
        <> <a href={publication.publisherUrl} target="_blank" rel="noopener noreferrer">Publisher link</a></>
      ) : null}
      {canManage ? (
        <div className="toolbar">
          <button type="button" onClick={() => setEditing(true)}>Edit</button>
          <button type="button" onClick={() => enrich.mutate()} disabled={enrich.isPending || !publication.doi}>
            Enrich Metadata
          </button>
          <ConfirmButton
            label="Delete"
            warning={`Delete "${publication.title}"? This cannot be undone.`}
            onConfirm={() => remove.mutate()}
            disabled={remove.isPending}
          />
        </div>
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
  const query = useQuery({
    queryKey: ['publications', projectId],
    queryFn: () => apiRequest<Publication[]>(
      `/api/v1/projects/${projectId}/publications`,
    ),
  })

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

  const toggleSelected = (id: string) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <main className="page">
      <h1>Publications</h1>
      {query.data ? (
        <p className="muted">{query.data.length} publication{query.data.length === 1 ? '' : 's'} in this project</p>
      ) : null}
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {canManage ? (
        <section className="card">
          <h2>Metadata Enrichment</h2>
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
        </section>
      ) : null}
      {canManage ? <MetadataConflictsPanel projectId={projectId} /> : null}
      <ul className="card-list stacked">
        {query.data?.map((publication) => (
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
