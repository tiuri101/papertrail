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
