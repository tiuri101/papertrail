export type SortDirection = 'asc' | 'desc'

/**
 * Compares two sort-key values: numeric subtraction when both are numbers,
 * otherwise a locale-aware, case-insensitive string comparison.
 */
export function compareSortValues(left: string | number, right: string | number): number {
  return typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right), undefined, { sensitivity: 'base' })
}

/**
 * Sorts a copy of `items` by a derived value, applying `direction`, and
 * falling back to `tiebreak` when two items compare equal — e.g. so a
 * secondary alphabetical order stays stable regardless of the primary sort.
 */
export function sortByValue<T>(
  items: T[],
  direction: SortDirection,
  valueOf: (item: T) => string | number,
  tiebreak: (left: T, right: T) => number,
): T[] {
  return [...items].sort((left, right) => {
    const comparison = compareSortValues(valueOf(left), valueOf(right))
    if (comparison !== 0) return direction === 'asc' ? comparison : -comparison
    return tiebreak(left, right)
  })
}
