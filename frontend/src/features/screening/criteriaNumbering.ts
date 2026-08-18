import type { ScreeningCriterion } from './useScreeningQueue'

export function sortedByKind(criteria: ScreeningCriterion[]): ScreeningCriterion[] {
  return [...criteria].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'inclusion' ? -1 : 1))
}

export function criterionNumbers(criteria: ScreeningCriterion[]): Record<string, string> {
  const counts: Record<string, number> = {}
  const numbers: Record<string, string> = {}
  sortedByKind(criteria).forEach((criterion) => {
    const prefix = criterion.kind === 'inclusion' ? 'IC' : 'EC'
    const count = (counts[criterion.kind] ?? 0) + 1
    counts[criterion.kind] = count
    numbers[criterion.id] = `${prefix}${count}`
  })
  return numbers
}
