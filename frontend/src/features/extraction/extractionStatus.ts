// The one place the publication-level extraction status is interpreted.
//
// `Publication.extractionStatus` is derived server-side
// (backend/app/extraction/status.py) from every slot a publication has plus
// whether a valid FinalExtraction exists. It is always present and always one
// of the six values below.
//
// The frontend used to reconstruct this itself -- treating a missing status
// as "not started" and anything non-`completed` as generic "in extraction" --
// which quietly got dual extraction wrong: one reviewer finishing while the
// second slot sat untouched looked identical to nobody having started, and
// two disagreeing submissions awaiting reconciliation looked identical to
// work in progress. Render the server's value; never re-derive it.

import type { BadgeVariant } from '../../components/Badge'

export const EXTRACTION_STATUSES = [
  'not_started',
  'available',
  'in_progress',
  'awaiting_second_reviewer',
  'awaiting_reconciliation',
  'completed',
] as const

export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number]

export function isExtractionStatus(value: unknown): value is ExtractionStatus {
  return typeof value === 'string' && (EXTRACTION_STATUSES as readonly string[]).includes(value)
}

const LABELS: Record<ExtractionStatus, string> = {
  not_started: 'Not started',
  available: 'Available',
  in_progress: 'In progress',
  awaiting_second_reviewer: 'Awaiting second reviewer',
  awaiting_reconciliation: 'Awaiting reconciliation',
  completed: 'Completed',
}

const VARIANTS: Record<ExtractionStatus, BadgeVariant> = {
  not_started: 'neutral',
  available: 'neutral',
  in_progress: 'warning',
  // Both of these need somebody to act, so they read as attention-worthy
  // rather than as ordinary progress.
  awaiting_second_reviewer: 'warning',
  awaiting_reconciliation: 'warning',
  completed: 'success',
}

/** Human-readable label for a publication's extraction status. */
export function extractionStatusLabel(status: string | null | undefined): string {
  if (!status) return LABELS.not_started
  return isExtractionStatus(status) ? LABELS[status] : status
}

/** Badge colour for a publication's extraction status. */
export function extractionStatusVariant(status: string | null | undefined): BadgeVariant {
  return isExtractionStatus(status) ? VARIANTS[status] : 'neutral'
}

/**
 * Whether extraction for this publication has reached its only "done" state:
 * a current, valid final result exists. Every other value -- including a
 * publication whose reviewers have all submitted but disagree -- is unfinished.
 */
export function isExtractionComplete(status: string | null | undefined): boolean {
  return status === 'completed'
}

/**
 * Whether extraction is under way for this publication: slots exist and no
 * authoritative result has been reached yet.
 */
export function isExtractionInFlight(status: string | null | undefined): boolean {
  return isExtractionStatus(status) && status !== 'not_started' && status !== 'completed'
}
