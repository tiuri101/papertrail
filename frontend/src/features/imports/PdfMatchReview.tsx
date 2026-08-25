import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CountPill } from '../../components/CountPill'
import { IconFile, IconUpload } from '../../components/icons'
import { statusPillClass } from '../../components/statusPillStyles'
import { formatFileSize } from '../../lib/format'
import { Select } from '../../components/Select'
import { Button } from '../../components/Button'
import { FieldLabel } from '../../components/FieldLabel'

interface MatchCandidate {
  publicationId: string
  title: string
  authors: string | null
  publicationYear: number | null
  score: number
  reason: string
}

interface MatchItem {
  id: string
  originalFilename: string
  fileSize: number | null
  detectedDoi: string | null
  detectedTitle: string | null
  detectedAuthors: string | null
  detectedYear: number | null
  status: string
  candidates: MatchCandidate[]
  matchedPublicationId: string | null
  errorMessage: string | null
}

interface MatchPublication {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  hasPdf: boolean
}

export interface PdfSummary {
  total: number
  matched: number
  ambiguous: number
  unmatched: number
  duplicate: number
  conflict_existing_pdf: number
  invalid: number
  skipped: number
}

interface MatchReview {
  summary: PdfSummary
  items: MatchItem[]
  publications: MatchPublication[]
}

const unresolved = new Set(['ambiguous', 'unmatched', 'conflict_existing_pdf'])

const STATUS_META: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  matched: { label: 'Matched', tone: 'success' },
  ambiguous: { label: 'Multiple possible matches', tone: 'warning' },
  unmatched: { label: 'No match found', tone: 'warning' },
  conflict_existing_pdf: { label: 'Existing PDF conflict', tone: 'danger' },
  duplicate: { label: 'Duplicate file', tone: 'neutral' },
  invalid: { label: 'Invalid PDF', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
}

const CANDIDATE_REASON_LABEL: Record<string, string> = {
  exact_doi: 'exact DOI match',
  exact_metadata_title: 'exact title match from the PDF metadata',
  exact_filename_title: 'exact title match from the filename',
  strong_title_author: 'similar title with overlapping authors',
}

function statusMeta(status: string): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  return STATUS_META[status] ?? { label: status.replaceAll('_', ' '), tone: 'neutral' }
}

function candidateDescription(candidate: MatchCandidate): string {
  const year = candidate.publicationYear ? ` (${candidate.publicationYear})` : ''
  const reason = CANDIDATE_REASON_LABEL[candidate.reason] ?? candidate.reason.replaceAll('_', ' ')
  return `${candidate.title}${year} — ${reason}`
}

export function PdfMatchReview({ projectId, importBatchId }: {
  projectId: string
  importBatchId?: string
}) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('needs_review')
  const [selections, setSelections] = useState<Record<string, string>>({})
  const queryKey = ['pdf-matches', projectId, importBatchId ?? 'project-wide']
  const endpoint = importBatchId
    ? `/api/v1/projects/${projectId}/imports/${importBatchId}/pdf-matches`
    : `/api/v1/projects/${projectId}/pdf-matches`
  const review = useQuery({ queryKey, queryFn: () => apiRequest<MatchReview>(endpoint) })
  const resolve = useMutation({
    mutationFn: ({ itemId, publicationId, action }: {
      itemId: string
      publicationId: string | null
      action: string
    }) => apiRequest(`${endpoint}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ itemId, publicationId, action }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  const publicationTitle = (publicationId: string | null) => (
    publicationId
      ? review.data?.publications.find((publication) => publication.id === publicationId)?.title ?? null
      : null
  )

  const counts = review.data?.summary
  const needsReviewCount = counts
    ? (counts.ambiguous ?? 0) + (counts.unmatched ?? 0) + (counts.conflict_existing_pdf ?? 0)
    : undefined

  const items = review.data?.items.filter((item) => (
    filter === 'all' ? true
      : filter === 'needs_review' ? unresolved.has(item.status)
        : item.status === filter
  )) ?? []

  return (
    <section className="card pdf-match-review" id={importBatchId ? undefined : 'section-pdf-review'}>
      <h2>Review PDF matches</h2>
      {review.error ? <p className="error" role="alert">{review.error.message}</p> : null}
      <FieldLabel>
        PDF match filter
        <Select value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="needs_review">Needs review{needsReviewCount !== undefined ? ` (${needsReviewCount})` : ''}</option>
          <option value="unmatched">Unmatched{counts ? ` (${counts.unmatched ?? 0})` : ''}</option>
          <option value="conflict_existing_pdf">Existing-PDF conflicts{counts ? ` (${counts.conflict_existing_pdf ?? 0})` : ''}</option>
          <option value="all">All{counts ? ` (${counts.total ?? 0})` : ''}</option>
        </Select>
      </FieldLabel>
      {review.data ? (
        <CountPill count={items.length}>
          {filter === 'all'
            ? `PDF file${items.length === 1 ? '' : 's'}`
            : `of ${counts?.total ?? review.data.items.length} PDF files match the current filter`}
        </CountPill>
      ) : null}
      <div className="card-list stacked mt-4">
        {items.map((item) => {
          const selected = selections[item.id]
            ?? item.matchedPublicationId
            ?? item.candidates[0]?.publicationId
            ?? ''
          const isConflict = item.status === 'conflict_existing_pdf'
          const meta = statusMeta(item.status)
          const publicationOptions = review.data?.publications ?? []
          const conflictTitle = isConflict ? publicationTitle(item.matchedPublicationId) : null
          const matchedTitle = item.status === 'matched' ? publicationTitle(item.matchedPublicationId) : null
          return (
            <article
              className="nested-card pdf-match-item rounded-md border border-border p-4 [&>*+*]:mt-3 [&>h3]:mt-0 [&>.toolbar:first-child]:mt-0 [&>.toolbar:last-child]:mb-0"
              key={item.id}
            >
              <header className="pdf-match-item__header flex items-start gap-3">
                <span className="pdf-match-item__icon inline-flex flex-none items-center justify-center w-[38px] h-[38px] rounded-sm bg-primary-container text-primary [&_svg]:w-5 [&_svg]:h-5 [&_svg]:fill-current" aria-hidden="true"><IconFile /></span>
                <div className="pdf-match-item__identity min-w-0 flex-1">
                  <h3 className="[overflow-wrap:anywhere]">{item.originalFilename}</h3>
                  {item.fileSize ? <span className="muted pdf-match-item__size block mt-0.5 text-[0.78rem]">{formatFileSize(item.fileSize)}</span> : null}
                </div>
                <span className={statusPillClass(meta.tone)}>{meta.label}</span>
              </header>

              <dl className="pdf-match-item__detected grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-4 gap-y-1 border-t border-border pt-3 text-[0.86rem]">
                <div>
                  <dt className="text-text-muted text-[0.72rem] font-bold tracking-[0.04em] uppercase">Detected title</dt>
                  <dd className="mt-0.5 mb-0 text-text-secondary [overflow-wrap:anywhere]">{item.detectedTitle ?? 'Not detected'}</dd>
                </div>
                {item.detectedAuthors ? (
                  <div>
                    <dt className="text-text-muted text-[0.72rem] font-bold tracking-[0.04em] uppercase">Authors</dt>
                    <dd className="mt-0.5 mb-0 text-text-secondary [overflow-wrap:anywhere]">{item.detectedAuthors}</dd>
                  </div>
                ) : null}
                {item.detectedYear ? (
                  <div>
                    <dt className="text-text-muted text-[0.72rem] font-bold tracking-[0.04em] uppercase">Year</dt>
                    <dd className="mt-0.5 mb-0 text-text-secondary [overflow-wrap:anywhere]">{item.detectedYear}</dd>
                  </div>
                ) : null}
                {item.detectedDoi ? (
                  <div>
                    <dt className="text-text-muted text-[0.72rem] font-bold tracking-[0.04em] uppercase">DOI</dt>
                    <dd className="mt-0.5 mb-0 text-text-secondary [overflow-wrap:anywhere]">{item.detectedDoi}</dd>
                  </div>
                ) : null}
              </dl>

              {item.errorMessage ? <p className="error">{item.errorMessage}</p> : null}

              {matchedTitle ? (
                <p className="pdf-match-item__note text-[0.88rem]">
                  Attached to <strong>{matchedTitle}</strong>
                </p>
              ) : null}

              {unresolved.has(item.status) ? (
                <>
                  {isConflict ? (
                    <p className="pdf-match-item__note pdf-match-item__note--warning text-[0.88rem] border-l-[3px] border-warning bg-warning-container px-3 py-2 text-text-secondary">
                      A PDF is already attached to{' '}
                      <strong>{conflictTitle ?? 'this publication'}</strong>. Replacing it keeps the
                      previous file in history.
                    </p>
                  ) : null}
                  {item.candidates.length ? (
                    <p className="muted pdf-match-item__hint text-[0.84rem]">
                      Suggested {item.candidates.length > 1 ? 'matches' : 'match'}:{' '}
                      {item.candidates.map(candidateDescription).join('; ')}
                    </p>
                  ) : null}
                  <FieldLabel>
                    Publication match for {item.originalFilename}
                    <Select
                      value={selected}
                      onChange={(event) => setSelections((current) => ({
                        ...current,
                        [item.id]: event.target.value,
                      }))}
                    >
                      <option value="">Choose a publication</option>
                      {publicationOptions.map((publication) => (
                        <option value={publication.id} key={publication.id}>
                          {publication.title}
                          {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
                          {publication.hasPdf ? ' · PDF attached' : ''}
                        </option>
                      ))}
                    </Select>
                  </FieldLabel>
                  <div className="toolbar">
                    <Button
                      type="button"
                      disabled={!selected || resolve.isPending || isConflict}
                      onClick={() => resolve.mutate({ itemId: item.id, publicationId: selected, action: 'attach' })}
                    >
                      <IconUpload />
                      Attach
                    </Button>
                    {isConflict ? (
                      <ConfirmButton
                        label="Replace existing"
                        confirmLabel="Replace Existing"
                        warning="Replace the existing PDF and retain it in history?"
                        onConfirm={() => resolve.mutate({ itemId: item.id, publicationId: selected, action: 'replace' })}
                        disabled={!selected || resolve.isPending}
                        icon={<IconUpload />}
                      />
                    ) : null}
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate({
                        itemId: item.id,
                        publicationId: null,
                        action: isConflict ? 'keep_existing' : 'skip',
                      })}
                    >
                      {isConflict ? 'Keep existing' : 'Skip'}
                    </Button>
                  </div>
                </>
              ) : null}
            </article>
          )
        })}
      </div>
      {items.length === 0 && review.data ? <p className="muted">No PDF matches in this view.</p> : null}
    </section>
  )
}
