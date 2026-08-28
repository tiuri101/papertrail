export function formatSubmittedAt(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

/** Date and time as separate strings, for compact stacked display in a narrow table column. */
export function formatSubmittedAtParts(value: string | null): { date: string; time: string | null } {
  if (!value) return { date: '—', time: null }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { date: '—', time: null }
  return { date: date.toLocaleDateString(), time: date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
}

/** "Year, venue" for the reviewer-facing screening/extraction/QA screens; falls back to whichever half is present. */
export function formatYearVenue(year: number | null | undefined, venue: string | null | undefined): string | null {
  if (year && venue) return `${year}, ${venue}`
  if (venue) return venue
  if (year) return `${year}`
  return null
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`
}
