import type { MouseEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { Button } from '../../components/Button'
import { DoiPill } from '../../components/DoiPill'
import { BookmarkToggle } from '../bookmarks/BookmarkToggle'
import { HighlightedText } from '../../components/HighlightedText'
import {
  reviewWorkActionsClass,
  reviewWorkCardClass,
  reviewWorkDoiClass,
  reviewWorkEditorClass,
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
import { formatSubmittedAtParts } from '../../lib/format'

/**
 * Shared row for the "my completed reviews" history pages (submitted
 * extractions, submitted quality assessments): a clickable publication
 * summary card with an inline expand-to-edit affordance. The two pages
 * differ in what the status pill shows, the edit button's label, and which
 * workspace component renders inline, so those are supplied by the caller.
 */
export function ReviewWorkRow({
  projectId,
  publicationId,
  detailHref,
  title,
  authors,
  venue,
  publicationYear,
  doi,
  submittedAt,
  statusContent,
  editLabel,
  highlightKeywords,
  renderEditor,
}: {
  projectId: string
  publicationId: string
  detailHref: string
  title: string
  authors: string | null
  venue: string | null
  publicationYear: number | null
  doi: string | null
  submittedAt: string | null
  statusContent: ReactNode
  editLabel: string
  highlightKeywords: string[]
  renderEditor: (helpers: { onDone: () => void }) => ReactNode
}) {
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const submitted = formatSubmittedAtParts(submittedAt)

  const openPublication = (event: MouseEvent<HTMLLIElement>) => {
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label, [data-review-work-editor]')) return
    navigate(detailHref)
  }

  return (
    <li className={reviewWorkCardClass} onClick={openPublication}>
      <div className={reviewWorkGridClass}>
        <div className={reviewWorkTitleClass}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Link className={reviewWorkTitleLinkClass} to={detailHref}>
                <h2 className={reviewWorkTitleTextClass}>
                  <HighlightedText text={title} keywords={highlightKeywords} />
                </h2>
              </Link>
              <div className={reviewWorkMetadataClass}>{authors ?? 'Unknown authors'}</div>
            </div>
            <BookmarkToggle projectId={projectId} publicationId={publicationId} />
          </div>
        </div>
        <span className={reviewWorkVenueClass} title={venue ?? undefined}>
          {venue ?? '—'}{publicationYear ? ` (${publicationYear})` : ''}
        </span>
        <span className={reviewWorkStatusClass}>{statusContent}</span>
        <span className={reviewWorkDoiClass}>
          {doi ? <DoiPill doi={doi} /> : <span className="text-text-muted">—</span>}
        </span>
        <time className={reviewWorkSubmittedClass} dateTime={submittedAt ?? undefined}>
          <span>{submitted.date}</span>
          {submitted.time ? <span className={reviewWorkSubmittedTimeClass}>{submitted.time}</span> : null}
        </time>
        <span className={reviewWorkActionsClass}>
          {!editing ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>{editLabel}</Button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <div className={reviewWorkEditorClass} data-review-work-editor>
          {renderEditor({ onDone: () => setEditing(false) })}
        </div>
      ) : null}
    </li>
  )
}
