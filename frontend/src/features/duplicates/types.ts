export interface UrlCheck {
  kind: 'publisher_url' | 'doi'
  url: string
  reachable: boolean | null
  statusCode: number | null
  checkedAt: string
}

export interface CandidatePublication {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  venue: string | null
  doi: string | null
  publisherUrl: string | null
  /** At least one screening decision is recorded on this record; merging it
   * away leaves those decisions behind on the merged-away record. */
  screened: boolean
  urlChecks: UrlCheck[]
}

/** Non-binding provider suggestion for an unresolved pair. `merge` points at
 * `providerRecommendedCanonicalId`; `distinct` / `uncertain` do not. */
export type ProviderRecommendation = 'merge' | 'distinct' | 'uncertain'

export type CandidateStatus = 'unresolved' | 'merged' | 'not_duplicate'

export interface Candidate {
  id: string
  publicationA: CandidatePublication
  publicationB: CandidatePublication
  matchReasons: string[]
  titleSimilarity: number | null
  authorSimilarity: number | null
  yearAgreement: boolean | null
  confidence: number
  status: CandidateStatus
  autoResolved: boolean
  resolvedById: string | null
  resolvedByName: string | null
  resolvedAt: string | null
  resolutionNote: string | null
  canonicalPublicationId: string | null
  mergeId: string | null
  /** Project stage the active merge was made in; null for older merges,
   * all of which were made in duplicate review. */
  mergeStage?: string | null
  reservedUntil: string | null
  reservedById: string | null
  providerRecommendation: ProviderRecommendation | null
  providerRecommendedCanonicalId: string | null
  providerRecommendationReason: string | null
  providerRecommendationSource: string | null
}

export interface DuplicateProgress {
  remaining: number
  resolved: number
  total: number
}

export type DuplicateChoice = 'a' | 'b' | 'not_duplicate'

/** Project stages in which duplicate pairs can still be decided: duplicate
 * review itself, and every later stage new records can be imported into
 * (they are checked for duplicates before they reach screening). */
const DUPLICATE_DECISION_STAGES = new Set([
  'duplicate_review',
  'title_abstract_screening',
  'full_text_screening',
  'extraction_quality',
  'completed',
])

export function takesDuplicateDecisions(projectStage: string): boolean {
  return DUPLICATE_DECISION_STAGES.has(projectStage)
}

/** Whether a resolved decision can still be changed in the project's current
 * stage. Mirrors the server rule: after duplicate review, a merge can only be
 * undone in the stage it was made in, and only while the merged-away record
 * carries no screening decisions of its own. */
export function canReviseDecision(candidate: Candidate, projectStage: string): boolean {
  if (projectStage === 'duplicate_review') return true
  if (!takesDuplicateDecisions(projectStage)) return false
  if (candidate.status !== 'merged') return true
  const mergedAway = candidate.canonicalPublicationId === candidate.publicationA.id
    ? candidate.publicationB
    : candidate.publicationA
  return (candidate.mergeStage ?? 'duplicate_review') === projectStage && !mergedAway.screened
}

/** The decision currently on record for a resolved candidate, or undefined
 * for an unresolved one (or a merge whose canonical record is neither A nor
 * B, which can only happen if the pair changed under us). */
export function currentChoice(candidate: Candidate): DuplicateChoice | undefined {
  if (candidate.status === 'not_duplicate') return 'not_duplicate'
  if (candidate.status === 'merged') {
    if (candidate.canonicalPublicationId === candidate.publicationA.id) return 'a'
    if (candidate.canonicalPublicationId === candidate.publicationB.id) return 'b'
  }
  return undefined
}

/** Which button the provider assessment points at, or undefined when there is
 * no actionable suggestion (no recommendation, "uncertain", or a "merge"
 * recommendation whose canonical record is neither A nor B). */
export function recommendedChoice(candidate: Candidate): DuplicateChoice | undefined {
  if (candidate.providerRecommendation === 'distinct') return 'not_duplicate'
  if (candidate.providerRecommendation === 'merge') {
    if (candidate.providerRecommendedCanonicalId === candidate.publicationA.id) return 'a'
    if (candidate.providerRecommendedCanonicalId === candidate.publicationB.id) return 'b'
  }
  return undefined
}

export function statusLabel(candidate: Candidate): string {
  if (candidate.status === 'not_duplicate') return 'Not a duplicate'
  if (candidate.status === 'unresolved') return 'Unresolved'
  if (candidate.autoResolved) return 'Auto-merged'
  const choice = currentChoice(candidate)
  return choice === 'a' ? 'Merged · kept A' : choice === 'b' ? 'Merged · kept B' : 'Merged'
}
