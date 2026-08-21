import { toolbarClass } from '../../components/layoutStyles'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Page } from '../../components/Page'
import { Button } from '../../components/Button'
import { Badge } from '../../components/Badge'
import { CountPill } from '../../components/CountPill'
import { DoiPill } from '../../components/DoiPill'
import { HighlightedText } from '../../components/HighlightedText'
import { Input } from '../../components/Input'
import { PublicationListSortHeader } from '../../components/PublicationListSortHeader'
import { Select } from '../../components/Select'
import { reviewWorkActionsClass, reviewWorkCardClass, reviewWorkDoiClass, reviewWorkEditorClass, reviewWorkGridClass, reviewWorkListClass, reviewWorkMetadataClass, reviewWorkStatusClass, reviewWorkSubmittedClass, reviewWorkTitleClass, reviewWorkTitleLinkClass, reviewWorkVenueClass } from '../../components/reviewWorkStyles'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
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
type SortDirection = 'asc' | 'desc'

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

function QualityRow({ projectId, entry, highlightKeywords }: {
  projectId: string
  entry: CompletedQualityAssessment
  highlightKeywords: string[]
}) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const queryClient = useQueryClient()
  const publication = entry.publication
  const detailHref = `/projects/${projectId}/publications/${publication.id}`

  const openPublication = (event: MouseEvent<HTMLLIElement>) => {
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label, [data-review-work-editor]')) return
    navigate(detailHref)
  }

  return (
    <li className={reviewWorkCardClass} onClick={openPublication}>
      <div className={reviewWorkGridClass}>
        <div className={reviewWorkTitleClass}>
          <Link className={reviewWorkTitleLinkClass} to={detailHref}>
            <h2 className="m-0 inline text-[inherit] leading-[inherit]">
              <HighlightedText text={publication.title} keywords={highlightKeywords} />
            </h2>
          </Link>
          <div className={reviewWorkMetadataClass}>{publication.authors ?? 'Unknown authors'}</div>
        </div>
        <span className={reviewWorkVenueClass} title={publication.venue ?? undefined}>
          {publication.venue ?? '—'}{publication.publicationYear ? ` (${publication.publicationYear})` : ''}
        </span>
        <span className={reviewWorkStatusClass}>
          <Badge>
            {entry.totalScore === null ? `Version ${entry.version}` : `Total score ${entry.totalScore} · v${entry.version}`}
          </Badge>
        </span>
        <span className={reviewWorkDoiClass}>
          {publication.doi ? <DoiPill doi={publication.doi} /> : <span className="text-text-muted">—</span>}
        </span>
        <time className={reviewWorkSubmittedClass} dateTime={entry.completedAt ?? undefined}>
          {formatSubmittedAt(entry.completedAt)}
        </time>
        <span className={reviewWorkActionsClass}>
          {!editing ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>Edit Quality Assessment</Button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <div data-review-work-editor="true" className={reviewWorkEditorClass}>
          <QualityWorkspace
            projectId={projectId}
            itemId={entry.id}
            variant="inline"
            onCancel={() => setEditing(false)}
            onSubmitted={() => {
              setEditing(false)
              queryClient.invalidateQueries({ queryKey: ['my-quality-assessments', projectId] })
            }}
          />
        </div>
      ) : null}
    </li>
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
                <label className="w-full flex-[0_1_32rem] max-w-lg">
                  Search papers
                  <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, author, DOI…" />
                </label>
                <label className="hidden max-[520px]:block">
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
              <div className={`${reviewWorkGridClass} mb-2 px-4 text-[0.72rem] font-bold tracking-[0.04em] text-text-muted uppercase max-[520px]:hidden`}>
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
              <ul className={reviewWorkListClass}>
                {filteredItems.map((entry) => <QualityRow key={entry.id} projectId={projectId} entry={entry} highlightKeywords={highlightKeywords} />)}
              </ul>
            </>
          )}
        </>
      ) : null}
    </Page>
  )
}
