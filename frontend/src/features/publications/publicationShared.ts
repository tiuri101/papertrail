import type { BadgeVariant } from '../../components/Badge'
import {
  isExtractionInFlight,
  type ExtractionStatus,
} from '../extraction/extractionStatus'

export interface ScreeningStatus {
  titleAbstract: string | null
  fullText: string | null
}

export interface Publication {
  id: string
  title: string
  authors: string | null
  abstract: string | null
  publicationYear: number | null
  venue: string | null
  publicationType: string | null
  doi: string | null
  publisherUrl: string | null
  keywords: string | null
  isbn: string | null
  issn: string | null
  pubmedId: string | null
  arxivId: string | null
  // Present on the full publication payloads; a deleted publication stays
  // readable by id with `isActive: false` and is excluded from every listing.
  isActive?: boolean
  fullText: {
    available: boolean
    retrievalStatus?: string | null
    document?: { pageCount: number | null } | null
  }
  screeningStatus?: ScreeningStatus
  // Always sent by the API and never null (backend/app/extraction/status.py).
  // Optional here only because a handful of narrower list endpoints project a
  // subset of publication fields.
  extractionStatus?: ExtractionStatus
}

const SCREENING_OUTCOME_LABELS: Record<string, string> = {
  include: 'Included',
  exclude: 'Excluded',
  uncertain: 'Uncertain',
  duplicate: 'Duplicate',
}

export function screeningLabel(outcome: string | null | undefined): string {
  if (!outcome) return 'Pending'
  return SCREENING_OUTCOME_LABELS[outcome] ?? outcome
}

// Full-text screening is skipped entirely when retrieval definitively fails
// (see backend/app/screening/routes.py), so those publications never get a
// screening decision and would otherwise be mislabeled "Pending" forever.
const FULL_TEXT_RETRIEVAL_FAILURE_LABELS: Record<string, string> = {
  not_found: 'Not found',
  inaccessible: 'Inaccessible',
}

export function fullTextRetrievalFailureLabel(retrievalStatus: string | null | undefined): string | null {
  if (!retrievalStatus) return null
  return FULL_TEXT_RETRIEVAL_FAILURE_LABELS[retrievalStatus] ?? null
}

export interface StagePill {
  label: string
  variant: BadgeVariant
}

// A single at-a-glance status, collapsing the two screening stages plus
// extraction into one badge (the full breakdown stays available in the
// workflow badges and the "Review details" panel).
export function primaryStage(publication: Publication): StagePill {
  const titleAbstract = publication.screeningStatus?.titleAbstract
  const fullText = publication.screeningStatus?.fullText

  if (titleAbstract === 'exclude') return { label: 'Excluded', variant: 'danger' }
  if (titleAbstract === 'uncertain') return { label: 'Uncertain', variant: 'warning' }
  if (titleAbstract === 'duplicate') return { label: 'Duplicate', variant: 'neutral' }
  if (!titleAbstract) return { label: 'New', variant: 'neutral' }

  if (fullText === 'exclude') return { label: 'Excluded', variant: 'danger' }
  if (fullText === 'uncertain') return { label: 'Uncertain', variant: 'warning' }
  if (fullText === 'duplicate') return { label: 'Duplicate', variant: 'neutral' }
  if (fullText === 'include') {
    // "Extraction" means extraction has started and has not reached an
    // authoritative result -- which now correctly covers a publication whose
    // reviewers have all submitted but disagree. `not_started` falls through
    // to "Included": nothing is pending on it.
    if (isExtractionInFlight(publication.extractionStatus)) {
      return { label: 'Extraction', variant: 'warning' }
    }
    return { label: 'Included', variant: 'success' }
  }

  const failureLabel = fullTextRetrievalFailureLabel(publication.fullText?.retrievalStatus)
  if (failureLabel) return { label: failureLabel, variant: 'danger' }
  if (publication.fullText?.available) return { label: 'Full-Text', variant: 'warning' }
  return { label: 'Screened', variant: 'neutral' }
}

// The screening stage a reviewer would act on next, or null once both
// stages have a decision (or title/abstract excluded the publication).
export function activeScreeningStage(publication: Publication): 'title_abstract' | 'full_text' | null {
  const titleAbstract = publication.screeningStatus?.titleAbstract
  const fullText = publication.screeningStatus?.fullText
  if (!titleAbstract) return 'title_abstract'
  if (titleAbstract === 'include' && !fullText) return 'full_text'
  return null
}

// The keys the publications list can be ordered by. Ordering itself is the
// server's job (backend/app/publications/listing.py): the list is paged, so
// only the database ever sees every publication that a sort has to arrange,
// and these names are the wire values it accepts. Sorting a page in the
// browser would only ever have reordered the page.
//
// `stage` orders by where a publication stands in the workflow -- the label
// `primaryStage` below produces, ranked New, Screened, Full-Text, Extraction,
// Included, Uncertain, Duplicate, Excluded, then the two retrieval failures.
// That ranking is reproduced as a SQL expression in `listing._stage_rank`;
// the two definitions must change together.
export type PublicationSortKey = 'title' | 'authors' | 'year' | 'source' | 'stage' | 'pdf'
export type SortDirection = 'asc' | 'desc'
