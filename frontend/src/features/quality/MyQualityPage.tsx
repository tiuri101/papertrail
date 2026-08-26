import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CountPill } from '../../components/CountPill'
import { Input } from '../../components/Input'
import { toolbarClass } from '../../components/layoutStyles'
import { Page } from '../../components/Page'
import { PublicationListSortHeader } from '../../components/PublicationListSortHeader'
import {
  reviewWorkActionsClass,
  reviewWorkGridClass,
  reviewWorkListClass,
} from '../../components/reviewWorkStyles'
import { statusPillClass } from '../../components/statusPillStyles'
import { Select } from '../../components/Select'
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
        <span className={statusPillClass()}>
          {entry.totalScore === null ? `Version ${entry.version}` : `Total score ${entry.totalScore} · v${entry.version}`}
        </span>
      )}
      editLabel="Edit Assessment"
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

  const toggleSort = (key: QualitySortKey) => {
    if (key === sortKey) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDirection(key === 'submitted' ? 'desc' : 'asc')
    }
  }

  return (
    <Page>
      <StageEyebrow stage="extraction_quality" />
      <h1>My Submitted Quality Assessments</h1>
      <p className="text-text-muted">Publications you have already assessed. Select a publication to view its details, or edit your assessment.</p>
      <p><Link to={`/projects/${projectId}/quality`}>← Back to quality assessment queue</Link></p>
      {query.error ? <p className="text-danger" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data ? (
        <>
          {query.data.length > 0 ? (
            <>
              <CountPill count={search ? filteredItems.length : query.data.length}>
                {search ? `of ${query.data.length} assessments match your filters` : `assessment${query.data.length === 1 ? '' : 's'}`}
              </CountPill>
              <div className={toolbarClass}>
                <label className="grid min-w-[min(20rem,100%)] flex-1 gap-1 text-sm font-semibold text-text-secondary">
                  Search papers
                  <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, author, DOI…" />
                </label>
                <label className="grid gap-1 text-sm font-semibold text-text-secondary hidden max-[520px]:grid">
                  Sort by
                  <Select value={`${sortKey}:${sortDirection}`} onChange={(event) => {
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
                  </Select>
                </label>
              </div>
            </>
          ) : null}
          {query.data.length === 0 ? (
            <p className="text-text-muted">You have not submitted any quality assessments yet.</p>
          ) : filteredItems.length === 0 ? (
            <p className="text-text-muted">No assessments match your filters.</p>
          ) : (
            <>
              <div className={`${reviewWorkGridClass} mt-6 mb-2 px-4 text-[0.72rem] font-bold tracking-[0.04em] text-text-muted uppercase max-[520px]:hidden`}>
                <span className="flex items-center gap-0.5">
                  <PublicationListSortHeader label="Title" sortKey="title" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />{' / '}
                  <PublicationListSortHeader label="Authors" sortKey="authors" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                </span>
                <PublicationListSortHeader label="Venue" sortKey="venue" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Score" sortKey="score" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="DOI" sortKey="doi" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <PublicationListSortHeader label="Submitted" sortKey="submitted" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
                <span className={reviewWorkActionsClass}>Actions</span>
              </div>
              <ul className={`${reviewWorkListClass} overflow-hidden rounded-md border border-border bg-surface`} aria-label="Submitted quality assessments">
                {filteredItems.map((entry) => <QualityRow key={entry.id} projectId={projectId} entry={entry} highlightKeywords={highlightKeywords} />)}
              </ul>
            </>
          )}
        </>
      ) : null}
    </Page>
  )
}
