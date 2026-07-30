import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'

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

function PublicationRow({ publication, projectId }: { publication: Publication; projectId: string }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)

  const remove = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/publications/${publication.id}`, {
      method: 'DELETE',
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['publications', projectId] }),
  })

  if (editing) {
    return (
      <li className="card">
        <PublicationEditForm publication={publication} projectId={projectId} onDone={() => setEditing(false)} />
      </li>
    )
  }

  return (
    <li className="card">
      <button type="button" className="link-button" onClick={() => setEditing(true)}>
        <strong>{publication.title}</strong>
      </button>
      {' — '}{publication.authors ?? 'Unknown authors'}
      {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
      {publication.doi ? (
        <> <a href={`https://doi.org/${publication.doi}`} target="_blank" rel="noopener noreferrer">DOI</a></>
      ) : null}
      {publication.publisherUrl ? (
        <> <a href={publication.publisherUrl} target="_blank" rel="noopener noreferrer">Publisher link</a></>
      ) : null}
      <div className="toolbar">
        <button type="button" onClick={() => setEditing(true)}>Edit</button>
        <ConfirmButton
          label="Delete"
          warning={`Delete "${publication.title}"? This cannot be undone.`}
          onConfirm={() => remove.mutate()}
          disabled={remove.isPending}
        />
      </div>
      {remove.error ? <p className="error" role="alert">{remove.error.message}</p> : null}
    </li>
  )
}

export function PublicationsPage() {
  const { projectId = '' } = useParams()
  const query = useQuery({
    queryKey: ['publications', projectId],
    queryFn: () => apiRequest<Publication[]>(
      `/api/v1/projects/${projectId}/publications`,
    ),
  })

  return (
    <main className="page">
      <h1>Publications</h1>
      {query.data ? (
        <p className="muted">{query.data.length} publication{query.data.length === 1 ? '' : 's'} in this project</p>
      ) : null}
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      <ul className="card-list">
        {query.data?.map((publication) => (
          <PublicationRow key={publication.id} publication={publication} projectId={projectId} />
        ))}
      </ul>
    </main>
  )
}
