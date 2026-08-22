import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CountPill } from '../../components/CountPill'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { type SortDirection, sortByValue } from '../../lib/sort'
import { ReviewWorkRow } from '../reviews/ReviewWorkRow'
import { StageEyebrow } from '../projects/StageEyebrow'
import { QualityWorkspace } from './QualityWorkspace'

interface QualityPublication {
  id: string
  title: string
  authors: string | null
  abstract: string | null
  publicationYear: number | null
  venue: string | null
  doi: string | null
  publisherUrl: string | null
}

interface CompletedQualityAssessment {
  id: string
  publicationId: string
  publication: QualityPublication
  completedAt: string | null
  version: number
  totalScore: number | null
}

type QualitySortKey = 'title' | 'authors' | 'venue' | 'score' | 'doi' | 'submitted'

function sortValue(entry: CompletedQualityAssessment, key: QualitySortKey): string | number {
  switch (key) {
    case 'title': return entry.publication.title.toLocaleLowerCase()
    case 'authors': return (entry.publication.authors ?? '').toLocaleLowerCase()
    case 'venue': return (entry.publication.venue ?? '').toLocaleLowerCase()
    case 'score': return entry.totalScore ?? Number.NEGATIVE_INFINITY
    case 'doi': return (entry.publication.doi ?? '').toLocaleLowerCase()
    case 'submitted': return entry.completedAt ? Date.parse(entry.completedAt) : 0
  }
}

function sortItems(items: CompletedQualityAssessment[], key: QualitySortKey, direction: SortDirection) {
  return sortByValue(
    items,
    direction,
    (item) => sortValue(item, key),
    (left, right) => left.publication.title.localeCompare(right.publication.title),
  )
}

function QualityRow({ projectId, entry, highlightKeywords }: {
  projectId: string
  entry: CompletedQualityAssessment
  highlightKeywords: string[]
}) {
  const queryClient = useQueryClient()
  const publication = entry.publication
  const detailHref = `/projects/${projectId}/publications/${publication.id}`

  return (
    <ReviewWorkRow
      detailHref={detailHref}
      title={publication.title}
      authors={publication.authors}
      venue={publication.venue}
      publicationYear={publication.publicationYear}
      doi={publication.doi}
      submittedAt={entry.completedAt}
      statusContent={(
        <span className="status-pill">
          {entry.totalScore === null ? `Version ${entry.version}` : `Total score ${entry.totalScore} · v${entry.version}`}
        </span>
      )}
      editLabel="Edit Quality Assessment"
      highlightKeywords={highlightKeywords}
      renderEditor={({ onDone }) => (
        <QualityWorkspace
          projectId={projectId}
          itemId={entry.id}
          variant="inline"
          onCancel={onDone}
          onSubmitted={() => {
            onDone()
            queryClient.invalidateQueries({ queryKey: ['my-quality-assessments', projectId] })
          }}
        />
      )}
    />
  )
}

export function MyQualityPage() {
  const { projectId = '' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<QualitySortKey>('submitted')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const query = useQuery({
    queryKey: ['my-quality-assessments', projectId],
    queryFn: () => apiRequest<CompletedQualityAssessment[]>(`/api/v1/projects/${projectId}/quality/mine`),
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
      <h1>My Submitted Quality Assessments</h1>
      <p className="muted">Publications you have already assessed. Select a publication to view its details, or edit your assessment.</p>
      <p><Link to={`/projects/${projectId}/quality`}>← Back to quality assessment queue</Link></p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data ? (
        <>
          {query.data.length > 0 ? (
            <>
              <CountPill count={search ? filteredItems.length : query.data.length}>
                {search ? `of ${query.data.length} assessments match your filters` : `assessment${query.data.length === 1 ? '' : 's'}`}
              </CountPill>
              <div className="toolbar">
                <label className="paper-search-field">
                  Search papers
                  <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, author, DOI…" />
                </label>
                <label>
                  Sort by
                  <select value={`${sortKey}:${sortDirection}`} onChange={(event) => {
                    const [key, direction] = event.target.value.split(':') as [QualitySortKey, SortDirection]
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
                    <option value="score:desc">Highest score</option>
                    <option value="score:asc">Lowest score</option>
                  </select>
                </label>
              </div>
            </>
          ) : null}
          {query.data.length === 0 ? (
            <p className="muted">You have not submitted any quality assessments yet.</p>
          ) : filteredItems.length === 0 ? (
            <p className="muted">No assessments match your filters.</p>
          ) : (
            <ul className="card-list stacked publication-list">
                {filteredItems.map((entry) => <QualityRow key={entry.id} projectId={projectId} entry={entry} highlightKeywords={highlightKeywords} />)}
            </ul>
          )}
        </>
      ) : null}
    </main>
  )
}
