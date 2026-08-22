import { useMutation, useQuery } from '@tanstack/react-query'
import { useMemo, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CountPill } from '../../components/CountPill'
import { DoiPill } from '../../components/DoiPill'
import { HighlightedText } from '../../components/HighlightedText'
import { PublicationListSortHeader } from '../../components/PublicationListSortHeader'
import {
  reviewWorkActionsClass,
  reviewWorkCardClass,
  reviewWorkDoiClass,
  reviewWorkGridClass,
  reviewWorkMetadataClass,
  reviewWorkStatusClass,
  reviewWorkSubmittedClass,
  reviewWorkSubmittedTimeClass,
  reviewWorkTitleClass,
  reviewWorkTitleLinkClass,
  reviewWorkTitleTextClass,
  reviewWorkVenueClass,
} from '../../components/reviewWorkStyles'
import { Tooltip } from '../../components/Tooltip'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { formatSubmittedAtParts } from '../../lib/format'
import { type SortDirection, sortByValue } from '../../lib/sort'
import { LlmEvidence } from '../llm/LlmTaskComponents'
import { StageEyebrow } from '../projects/StageEyebrow'
import type { ValidationResult } from './types'

interface ValidationReviewItem {
  workItemId: string
  publicationId: string
  responseId: string | null
  submittedAt: string | null
  fullTextAvailable: boolean
  state: string
  error: string | null
  publication: {
    id: string
    title: string
    authors: string | null
    publicationYear: number | null
    venue: string | null
    doi: string | null
  }
  results: ValidationResult[]
}

interface ValidationReview {
  enabled: boolean
  progress: {
    total: number
    completed: number
    pending: number
    failed: number
    unavailable: number
    outstanding: number
    settled: boolean
  }
  items: ValidationReviewItem[]
}

type ReviewItem = ValidationReviewItem & { issues: ValidationResult[] }
type ValidationSortKey = 'title' | 'authors' | 'venue' | 'status' | 'doi' | 'submitted'

const NEEDS_REVIEW = new Set(['contradicted', 'uncertain', 'not_verifiable'])

const ASSESSMENT_HELP: Record<ValidationResult['assessment'], string> = {
  supported: 'The AI found evidence in the full text that agrees with the value a human entered for this field.',
  contradicted: 'The AI found evidence in the full text that conflicts with the human-entered value — check the evidence below and correct the extraction if the AI is right.',
  uncertain: 'The AI could not confidently confirm or refute the human-entered value from the text it had access to.',
  not_verifiable: "The AI couldn't find any relevant evidence in the full text to check this value against.",
}

function statusLabel(item: ReviewItem) {
  if (item.state === 'ready') return `${item.issues.length} field${item.issues.length === 1 ? '' : 's'} need review`
  const labels: Record<string, string> = {
    failed: 'Validation failed',
    awaiting_validation: 'Awaiting validation',
    queued: 'Validation queued',
    processing: 'Validating',
    unavailable: 'Validation unavailable',
    awaiting_final: 'Awaiting final extraction',
    waiting_for_extraction: 'Awaiting extraction',
  }
  return labels[item.state] ?? item.state.replaceAll('_', ' ')
}

function statusClass(item: ReviewItem) {
  if (item.state === 'failed') return 'status-pill status-pill--danger'
  if (item.state === 'ready' && item.issues.length > 0) return 'status-pill status-pill--warning'
  return 'status-pill'
}

function sortValue(item: ReviewItem, key: ValidationSortKey): string | number {
  switch (key) {
    case 'title': return item.publication.title.toLocaleLowerCase()
    case 'authors': return (item.publication.authors ?? '').toLocaleLowerCase()
    case 'venue': return (item.publication.venue ?? '').toLocaleLowerCase()
    case 'status': return statusLabel(item).toLocaleLowerCase()
    case 'doi': return (item.publication.doi ?? '').toLocaleLowerCase()
    case 'submitted': return item.submittedAt ? Date.parse(item.submittedAt) : 0
  }
}

function sortItems(items: ReviewItem[], key: ValidationSortKey, direction: SortDirection) {
  return sortByValue(
    items,
    direction,
    (item) => sortValue(item, key),
    (left, right) => left.publication.title.localeCompare(right.publication.title),
  )
}

function ValidationRow({
  projectId,
  item,
  highlightKeywords,
  retry,
}: {
  projectId: string
  item: ReviewItem
  highlightKeywords: string[]
  retry: (item: ValidationReviewItem) => void
}) {
  const navigate = useNavigate()
  const publication = item.publication
  const detailHref = `/projects/${projectId}/publications/${publication.id}`
  const submitted = formatSubmittedAtParts(item.submittedAt)

  const openPublication = (event: MouseEvent<HTMLLIElement>) => {
    if ((event.target as HTMLElement).closest('a, button, details, summary, .validation-review-card__issues')) return
    navigate(detailHref)
  }

  return (
    <li className={reviewWorkCardClass} onClick={openPublication}>
      <div className={reviewWorkGridClass}>
        <div className={reviewWorkTitleClass}>
          <Link className={reviewWorkTitleLinkClass} to={detailHref}>
            <h2 className={reviewWorkTitleTextClass}>
              <HighlightedText text={publication.title} keywords={highlightKeywords} />
            </h2>
          </Link>
          <div className={reviewWorkMetadataClass}>{publication.authors ?? 'Unknown authors'}</div>
        </div>
        <span className={reviewWorkVenueClass} title={publication.venue ?? undefined}>
          {publication.venue ?? '—'}{publication.publicationYear ? ` (${publication.publicationYear})` : ''}
        </span>
        <span className={reviewWorkStatusClass}><span className={statusClass(item)}>{statusLabel(item)}</span></span>
        <span className={reviewWorkDoiClass}>
          {publication.doi ? <DoiPill doi={publication.doi} /> : <span className="text-text-muted">—</span>}
        </span>
        <time className={reviewWorkSubmittedClass} dateTime={item.submittedAt ?? undefined}>
          <span>{submitted.date}</span>
          {submitted.time ? <span className={reviewWorkSubmittedTimeClass}>{submitted.time}</span> : null}
        </time>
        <span className={reviewWorkActionsClass}>
          <Link className="button-secondary button-sm" to={`/projects/${projectId}/extraction/review/${item.workItemId}`}>
            Review and correct extraction
          </Link>
        </span>
      </div>

      {item.issues.length > 0 || item.error || item.fullTextAvailable || ['failed', 'awaiting_validation'].includes(item.state) ? (
        <details className="validation-review-card__issues" open={item.issues.length > 0}>
          <summary>{item.issues.length > 0 ? `Validation findings (${item.issues.length})` : 'Validation details'}</summary>
          {item.error ? <p className="error">{item.error}</p> : null}
          {item.issues.map((result) => (
            <section className={`llm-validation llm-validation--${result.assessment}`} key={result.fieldKey}>
              <h3>{result.fieldLabel}</h3>
              <p>
                <Tooltip text={ASSESSMENT_HELP[result.assessment]}>
                  <strong>{result.assessment.replaceAll('_', ' ')}</strong>
                </Tooltip>
              </p>
              <p>Human value: <code>{JSON.stringify(result.value)}</code></p>
              <p>{result.explanation}</p>
              {result.evidence.length ? (
                <details>
                  <summary>Evidence ({result.evidence.length})</summary>
                  <LlmEvidence evidence={result.evidence} projectId={projectId} publicationId={item.publicationId} />
                </details>
              ) : null}
            </section>
          ))}
          <div className="toolbar">
            {item.fullTextAvailable ? (
              <a href={`/api/v1/projects/${projectId}/publications/${item.publicationId}/full-text/content`} target="_blank" rel="noreferrer">
                View PDF
              </a>
            ) : null}
            {['failed', 'awaiting_validation'].includes(item.state) ? (
              <button type="button" className="button-secondary" onClick={() => retry(item)}>Retry validation</button>
            ) : null}
          </div>
        </details>
      ) : null}
    </li>
  )
}

export function ValidationReviewPage() {
  const { projectId = '' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<ValidationSortKey>('submitted')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const review = useQuery({
    queryKey: ['extraction-validation-review', projectId],
    queryFn: () => apiRequest<ValidationReview>(`/api/v1/projects/${projectId}/llm/extraction-validation-review`),
    enabled: Boolean(projectId),
    refetchInterval: (query) => (query.state.data?.progress.settled ? false : 5000),
  })
  const retry = useMutation({
    mutationFn: (item: ValidationReviewItem) => apiRequest(
      `/api/v1/projects/${projectId}/extraction/${item.workItemId}/llm-validation`,
      { method: 'POST', body: JSON.stringify({ force: Boolean(item.responseId) }) },
    ),
    onSuccess: () => review.refetch(),
  })

  const visibleItems = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const items = (review.data?.items ?? [])
      .map((item) => ({ ...item, issues: item.results.filter((result) => NEEDS_REVIEW.has(result.assessment)) }))
      .filter((item) => item.state !== 'ready' || item.issues.length > 0)
      .filter((item) => {
        const searchable = [item.publication.title, item.publication.authors, item.publication.venue, item.publication.doi, statusLabel(item)]
          .filter(Boolean).join(' ').toLocaleLowerCase()
        return !normalizedSearch || searchable.includes(normalizedSearch)
      })
    return sortItems(items, sortKey, sortDirection)
  }, [review.data?.items, search, sortDirection, sortKey])

  const totalReviewItems = useMemo(() => (review.data?.items ?? [])
    .map((item) => ({ ...item, issues: item.results.filter((result) => NEEDS_REVIEW.has(result.assessment)) }))
    .filter((item) => item.state !== 'ready' || item.issues.length > 0).length, [review.data?.items])

  const toggleSort = (key: ValidationSortKey) => {
    if (key === sortKey) setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDirection(key === 'submitted' ? 'desc' : 'asc')
    }
  }

  if (review.isLoading) return <main className="page"><p>Loading validation review…</p></main>
  if (review.isError || !review.data) return <main className="page"><p className="error" role="alert">Validation review could not be loaded.</p></main>
  if (!review.data.enabled) {
    return <main className="page"><StageEyebrow stage="extraction_quality" /><h1>LLM Extraction Validation</h1><p>LLM extraction validation is not enabled for this project.</p></main>
  }

  return (
    <main className="page">
      <StageEyebrow stage="extraction_quality" />
      <h1>Review LLM Extraction Validation</h1>
      <section className="card">
        <h2>Validation progress</h2>
        <CountPill count={review.data.progress.completed}>
          of {review.data.progress.total} validated
          {review.data.progress.pending ? ` · ${review.data.progress.pending} processing` : ''}
          {review.data.progress.failed ? ` · ${review.data.progress.failed} failed` : ''}
          {review.data.progress.unavailable ? ` · ${review.data.progress.unavailable} unavailable` : ''}
        </CountPill>
        <p className="muted">Human extraction values remain authoritative. Review flagged fields, then correct the extraction if needed.</p>
      </section>

      {retry.error ? <p className="error" role="alert">{retry.error.message}</p> : null}
      {totalReviewItems > 0 ? (
        <>
          <CountPill count={search ? visibleItems.length : totalReviewItems}>
            {search ? `of ${totalReviewItems} publications match your filters` : `publication${totalReviewItems === 1 ? '' : 's'} need review`}
          </CountPill>
          <div className="toolbar">
            <label className="paper-search-field">
              Search papers
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, author, DOI…" />
            </label>
            <label className="review-work-mobile-sort">
              Sort by
              <select value={`${sortKey}:${sortDirection}`} onChange={(event) => {
                const [key, direction] = event.target.value.split(':') as [ValidationSortKey, SortDirection]
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
                <option value="status:asc">Status A–Z</option>
                <option value="status:desc">Status Z–A</option>
              </select>
            </label>
          </div>
        </>
      ) : null}

      {totalReviewItems === 0 ? (
        <section className="card"><p>No validation mismatches require review.</p></section>
      ) : visibleItems.length === 0 ? (
        <p className="muted">No validation items match your filters.</p>
      ) : (
        <>
          <div className={`${reviewWorkGridClass} mb-2 px-4 text-[0.72rem] font-bold tracking-[0.04em] text-text-muted uppercase max-[520px]:hidden`}>
            <span className="flex items-center gap-0.5">
              <PublicationListSortHeader label="Title" sortKey="title" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />{' / '}
              <PublicationListSortHeader label="Authors" sortKey="authors" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
            </span>
            <PublicationListSortHeader label="Venue" sortKey="venue" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
            <PublicationListSortHeader label="Status" sortKey="status" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
            <PublicationListSortHeader label="DOI" sortKey="doi" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
            <PublicationListSortHeader label="Submitted" sortKey="submitted" activeKey={sortKey} direction={sortDirection} onToggle={toggleSort} />
            <span className={reviewWorkActionsClass}>Actions</span>
          </div>
          <ul className="card-list stacked publication-list">
            {visibleItems.map((item) => (
              <ValidationRow key={item.workItemId} projectId={projectId} item={item} highlightKeywords={highlightKeywords} retry={(target) => retry.mutate(target)} />
            ))}
          </ul>
        </>
      )}
    </main>
  )
}
