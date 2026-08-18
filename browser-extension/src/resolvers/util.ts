import type { PdfCandidate } from './resolver'

export function dedupeCandidates(candidates: PdfCandidate[]): PdfCandidate[] {
  const seen = new Set<string>()
  const result: PdfCandidate[] = []
  for (const candidate of [...candidates].sort((a, b) => b.confidence - a.confidence)) {
    if (seen.has(candidate.url)) continue
    seen.add(candidate.url)
    result.push(candidate)
  }
  return result
}

export function resolveHref(href: string | null | undefined, base: string): string | null {
  if (!href) return null
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}
