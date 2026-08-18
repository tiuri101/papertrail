import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { DoiPill } from '../../components/DoiPill'
import { HighlightedText } from '../../components/HighlightedText'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { isSafeHttpUrl } from '../../lib/safeUrl'
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

function ExtractionCard({
  projectId,
  entry,
  highlightKeywords,
}: {
  projectId: string
  entry: CompletedExtraction
  highlightKeywords: string[]
}) {
  const [editing, setEditing] = useState(false)
  const queryClient = useQueryClient()
  const publication = entry.publication

  return (
    <li className="card publication-card decision-card">
      <div className="publication-card__summary">
        <div>
          <h2 className="decision-card__title">
            <HighlightedText text={publication.title} keywords={highlightKeywords} />
          </h2>
          {' — '}{publication.authors ?? 'Unknown authors'}
          {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
          {' '}
          <span className="muted">v{entry.version}</span>
        </div>
      </div>
      <div className="publication-card__workflow">
        <DoiPill doi={publication.doi} />
        {isSafeHttpUrl(publication.publisherUrl) ? (
          <PublisherLinkPill url={publication.publisherUrl!} />
        ) : null}
      </div>
      <details className="publication-card__abstract">
        <summary>Publication details</summary>
        {publication.venue ? <p><strong>Venue:</strong> {publication.venue}</p> : null}
        <p>
          <strong>Abstract:</strong>{' '}
          {publication.abstract
            ? <HighlightedText text={publication.abstract} keywords={highlightKeywords} />
            : 'No abstract available.'}
        </p>
        {entry.completedAt ? <p className="muted">Submitted {new Date(entry.completedAt).toLocaleString()}</p> : null}
      </details>
      {editing ? (
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
      ) : (
        <div className="toolbar publication-card__actions">
          <button type="button" className="button-secondary" onClick={() => setEditing(true)}>Edit Extraction</button>
        </div>
      )}
    </li>
  )
}

export function MyExtractionsPage() {
  const { projectId = '' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('newest')
  const query = useQuery({
    queryKey: ['my-extractions', projectId],
    queryFn: () => apiRequest<CompletedExtraction[]>(`/api/v1/projects/${projectId}/extraction/mine`),
    enabled: Boolean(projectId),
  })

  const filteredItems = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const items = (query.data ?? []).filter((entry) => {
      const publication = entry.publication
      const searchable = [
        publication.title,
        publication.authors,
        publication.abstract,
        publication.venue,
        publication.doi,
      ].filter(Boolean).join(' ').toLocaleLowerCase()
      return !normalizedSearch || searchable.includes(normalizedSearch)
    })
    return items.sort((left, right) => {
      if (sort === 'title_asc') return left.publication.title.localeCompare(right.publication.title)
      if (sort === 'title_desc') return right.publication.title.localeCompare(left.publication.title)
      const leftTime = left.completedAt ? Date.parse(left.completedAt) : 0
      const rightTime = right.completedAt ? Date.parse(right.completedAt) : 0
      return sort === 'oldest' ? leftTime - rightTime : rightTime - leftTime
    })
  }, [query.data, search, sort])

  return (
    <main className="page">
      <StageEyebrow stage="extraction_quality" />
      <h1>My Submitted Extractions</h1>
      <p className="muted">
        Publications you have already extracted. Open one to revisit and correct your answers —
        each correction is saved as a new, separately tracked version.
      </p>
      <p><Link to={`/projects/${projectId}/extraction`}>← Back to extraction queue</Link></p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data ? (
        <>
          {query.data.length > 0 ? (
            <>
              <p className="muted">
                {search
                  ? `${filteredItems.length} of ${query.data.length} extractions match your filters`
                  : `${query.data.length} extraction${query.data.length === 1 ? '' : 's'}`}
              </p>
              <div className="toolbar">
                <label className="paper-search-field">
                  Search papers
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Title, author, DOI…"
                  />
                </label>
                <label>
                  Sort by
                  <select value={sort} onChange={(event) => setSort(event.target.value)}>
                    <option value="newest">Newest submission</option>
                    <option value="oldest">Oldest submission</option>
                    <option value="title_asc">Title A–Z</option>
                    <option value="title_desc">Title Z–A</option>
                  </select>
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
              {filteredItems.map((entry) => (
                <ExtractionCard
                  key={entry.id}
                  projectId={projectId}
                  entry={entry}
                  highlightKeywords={highlightKeywords}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
    </main>
  )
}
