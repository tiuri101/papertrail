import type { MouseEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { DoiPill } from '../../components/DoiPill'
import { HighlightedText } from '../../components/HighlightedText'
import { formatSubmittedAt } from '../../lib/format'

/**
 * Shared row for the "my completed reviews" history pages (submitted
 * extractions, submitted quality assessments): a clickable publication
 * summary card with an inline expand-to-edit affordance. The two pages
 * differ in what the status pill shows, the edit button's label, and which
 * workspace component renders inline, so those are supplied by the caller.
 */
export function ReviewWorkRow({
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
              <HighlightedText text={title} keywords={highlightKeywords} />
            </h2>
          </Link>
          <div className="review-work-row-grid__authors">{authors ?? 'Unknown authors'}</div>
        </div>
        <span className="review-work-row-grid__venue" title={venue ?? undefined}>
          {venue ?? '—'}{publicationYear ? ` (${publicationYear})` : ''}
        </span>
        <span className="review-work-row-grid__status">{statusContent}</span>
        <span className="review-work-row-grid__doi">
          {doi ? <DoiPill doi={doi} /> : <span className="muted">—</span>}
        </span>
        <time className="review-work-row-grid__submitted" dateTime={submittedAt ?? undefined}>
          {formatSubmittedAt(submittedAt)}
        </time>
        <span className="review-work-row-grid__actions">
          {!editing ? (
            <button type="button" className="button-secondary button-sm" onClick={() => setEditing(true)}>{editLabel}</button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <div className="review-work-card__editor">
          {renderEditor({ onDone: () => setEditing(false) })}
        </div>
      ) : null}
    </li>
  )
}
