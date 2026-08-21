import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CountPill } from '../../components/CountPill'
import { DoiPill } from '../../components/DoiPill'
import { HighlightedText } from '../../components/HighlightedText'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { StageEyebrow } from '../projects/StageEyebrow'
import { ExtractionWorkspace } from './ExtractionWorkspace'

interface ExtractionPublication {
  id: string
  title: string
  authors: string | null
  abstract: string | null
  publicationYear: number | null
  venue: string | null
  doi: string | null
  publisherUrl: string | null
}

interface CompletedExtraction {
  id: string
  publicationId: string
  publication: ExtractionPublication
  completedAt: string | null
  version: number
}

type ExtractionSortKey = 'title' | 'authors' | 'venue' | 'version' | 'doi' | 'submitted'
type SortDirection = 'asc' | 'desc'

function sortValue(entry: CompletedExtraction, key: ExtractionSortKey): string | number {
  switch (key) {
    case 'title': return entry.publication.title.toLocaleLowerCase()
    case 'authors': return (entry.publication.authors ?? '').toLocaleLowerCase()
    case 'venue': return (entry.publication.venue ?? '').toLocaleLowerCase()
    case 'version': return entry.version
    case 'doi': return (entry.publication.doi ?? '').toLocaleLowerCase()
    case 'submitted': return entry.completedAt ? Date.parse(entry.completedAt) : 0
  }
}

function sortItems(items: CompletedExtraction[], key: ExtractionSortKey, direction: SortDirection) {
  return [...items].sort((left, right) => {
    const leftValue = sortValue(left, key)
    const rightValue = sortValue(right, key)
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base' })
    if (comparison !== 0) return direction === 'asc' ? comparison : -comparison
    return left.publication.title.localeCompare(right.publication.title)
  })
}

function formatSubmittedAt(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function ExtractionRow({ projectId, entry, highlightKeywords }: {
  projectId: string
  entry: CompletedExtraction
  highlightKeywords: string[]
}) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const queryClient = useQueryClient()
  const publication = entry.publication
  const detailHref = `/projects/${projectId}/publications/${publication.id}`

  const openPublication = (event: MouseEvent<HTMLLIElement>) => {
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label, .review-work-card__editor')) return
    navigate(detailHref)
  }

  return (
    <li className="card publication-card review-work-card--clickable" onClick={openPublication}>
      <div className="publication-card__summary review-work-row-grid">
        <div className="review-work-row-grid__title">
          <Link className="publication-card__title-button" to={detailHref}>
            <h2 className="decision-card__title">
              <HighlightedText text={publication.title} keywords={highlightKeywords} />
            </h2>
          </Link>
          <div className="review-work-row-grid__authors">{publication.authors ?? 'Unknown authors'}</div>
        </div>
        <span className="review-work-row-grid__venue" title={publication.venue ?? undefined}>
          {publication.venue ?? '—'}{publication.publicationYear ? ` (${publication.publicationYear})` : ''}
        </span>
        <span className="review-work-row-grid__status"><span className="status-pill">v{entry.version}</span></span>
        <span className="review-work-row-grid__doi">
          {publication.doi ? <DoiPill doi={publication.doi} /> : <span className="muted">—</span>}
        </span>
        <time className="review-work-row-grid__submitted" dateTime={entry.completedAt ?? undefined}>
          {formatSubmittedAt(entry.completedAt)}
        </time>
        <span className="review-work-row-grid__actions">
          {!editing ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>Edit Extraction</Button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <div className="review-work-card__editor">
          <ExtractionWorkspace
            projectId={projectId}
            itemId={entry.id}
            variant="inline"
            onCancel={() => setEditing(false)}
            onSubmitted={() => {
              setEditing(false)
              queryClient.invalidateQueries({ queryKey: ['my-extractions', projectId] })
            }}
          />
        </div>
      ) : null}
    </li>
  )
}

export function MyExtractionsPage() {
  const { projectId = '' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<ExtractionSortKey>('submitted')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const query = useQuery({
    queryKey: ['my-extractions', projectId],
    queryFn: () => apiRequest<CompletedExtraction[]>(`/api/v1/projects/${projectId}/extraction/mine`),
    enabled: Boolean(projectId),
  })

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const items = (query.data ?? []).filter((entry) => {
      const publication = entry.publication
      const searchable = [publication.title, publication.authors, publication.abstract, publication.venue, publication.doi]
        .filter(Boolean).join(' ').toLocaleLowerCase()
      return !normalizedSearch || searchable.includes(normalizedSearch)
    })
    return sortItems(items, sortKey, sortDirection)
  }, [query.data, search, sortDirection, sortKey])

  return (
    <main className="page">
      <StageEyebrow stage="extraction_quality" />
      <h1>My Submitted Extractions</h1>
      <p className="muted">Publications you have already extracted. Select a publication to view its details, or edit your extraction.</p>
      <p><Link to={`/projects/${projectId}/extraction`}>← Back to extraction queue</Link></p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data ? (
        <>
          {query.data.length > 0 ? (
            <>
              <CountPill count={search ? filteredItems.length : query.data.length}>
                {search ? `of ${query.data.length} extractions match your filters` : `extraction${query.data.length === 1 ? '' : 's'}`}
              </CountPill>
              <div className="toolbar">
                <label className="paper-search-field">
                  Search papers
                  <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, author, DOI…" />
                </label>
                <label>
                  Sort by
                  <Select value={`${sortKey}:${sortDirection}`} onChange={(event) => {
                    const [key, direction] = event.target.value.split(':') as [ExtractionSortKey, SortDirection]
                    setSortKey(key)
                    setSortDirection(direction)
                  }}>
                    <option value="submitted:desc">Newest submission</option>
                    <option value="submitted:asc">Oldest submission</option>
                    <option value="title:asc">Title A–Z</option>
                    <option value="title:desc">Title Z–A</option>
                    <option value="authors:asc">Authors A–Z</option>
                    <option value="authors:desc">Authors Z–A</option>
                    <option value="venue:asc">Venue A–Z</option>
                    <option value="venue:desc">Venue Z–A</option>
                    <option value="version:desc">Newest version</option>
                    <option value="version:asc">Oldest version</option>
                  </Select>
                </label>
              </div>
            </>
          ) : null}
          {query.data.length === 0 ? (
            <p className="muted">You have not submitted any extractions yet.</p>
          ) : filteredItems.length === 0 ? (
            <p className="muted">No extractions match your filters.</p>
          ) : (
            <ul className="card-list stacked publication-list">
                {filteredItems.map((entry) => <ExtractionRow key={entry.id} projectId={projectId} entry={entry} highlightKeywords={highlightKeywords} />)}
            </ul>
          )}
        </>
      ) : null}
    </main>
  )
}
