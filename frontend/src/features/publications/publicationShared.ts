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
  fullText: {
    available: boolean
    retrievalStatus?: string | null
    document?: { pageCount: number | null } | null
  }
  screeningStatus?: ScreeningStatus
  extractionStatus?: string | null
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
  className: string
}

// A single at-a-glance status, collapsing the two screening stages plus
// extraction into one badge (the full breakdown stays available in the
// workflow badges and the "Review details" panel).
export function primaryStage(publication: Publication): StagePill {
  const titleAbstract = publication.screeningStatus?.titleAbstract
  const fullText = publication.screeningStatus?.fullText

  if (titleAbstract === 'exclude') return { label: 'Excluded', className: 'status-badge--danger' }
  if (titleAbstract === 'uncertain') return { label: 'Uncertain', className: 'status-badge--warning' }
  if (titleAbstract === 'duplicate') return { label: 'Duplicate', className: 'status-badge--neutral' }
  if (!titleAbstract) return { label: 'New', className: 'status-badge--pending' }

  if (fullText === 'exclude') return { label: 'Excluded', className: 'status-badge--danger' }
  if (fullText === 'uncertain') return { label: 'Uncertain', className: 'status-badge--warning' }
  if (fullText === 'duplicate') return { label: 'Duplicate', className: 'status-badge--neutral' }
  if (fullText === 'include') {
    if (publication.extractionStatus && publication.extractionStatus !== 'completed') {
      return { label: 'Extraction', className: 'status-badge--warning' }
    }
    return { label: 'Included', className: 'status-badge--success' }
  }

  const failureLabel = fullTextRetrievalFailureLabel(publication.fullText?.retrievalStatus)
  if (failureLabel) return { label: failureLabel, className: 'status-badge--danger' }
  if (publication.fullText?.available) return { label: 'Full-Text', className: 'status-badge--warning' }
  return { label: 'Screened', className: 'status-badge--neutral' }
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

export type PublicationSortKey = 'title' | 'authors' | 'year' | 'source' | 'stage' | 'pdf'
export type SortDirection = 'asc' | 'desc'

// Roughly the order a reviewer moves a publication through the workflow, so
// sorting by stage reads as progress rather than an arbitrary alphabetical
// jumble. Anything not listed here (a future stage label) sorts last.
const STAGE_SORT_RANK: Record<string, number> = {
  New: 0,
  Screened: 1,
  'Full-Text': 2,
  Extraction: 3,
  Included: 4,
  Uncertain: 5,
  Duplicate: 6,
  Excluded: 7,
  'Not found': 8,
  Inaccessible: 8,
}

function publicationSortValue(publication: Publication, key: PublicationSortKey): string | number {
  switch (key) {
    case 'title':
      return (publication.title ?? '').toLocaleLowerCase()
    case 'authors':
      return (publication.authors ?? '').toLocaleLowerCase()
    case 'year':
      return publication.publicationYear ?? -Infinity
    case 'source':
      return (publication.venue ?? '').toLocaleLowerCase()
    case 'stage':
      return STAGE_SORT_RANK[primaryStage(publication).label] ?? 99
    case 'pdf':
      return publication.fullText?.available ? 1 : 0
    default:
      return ''
  }
}

export function sortPublications<T extends Publication>(
  publications: T[],
  key: PublicationSortKey,
  direction: SortDirection,
): T[] {
  const sorted = [...publications]
  sorted.sort((left, right) => {
    const leftValue = publicationSortValue(left, key)
    const rightValue = publicationSortValue(right, key)
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base' })
    return direction === 'asc' ? comparison : -comparison
  })
  return sorted
}
