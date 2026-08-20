export function PdfAvailabilityPill({ available, href, pageCount, compact = false }: {
  available: boolean
  href: string
  pageCount?: number | null
  /** Short label with no page count (e.g. a table's PDF column) -- still shown as visible text, not just an icon. */
  compact?: boolean
}) {
  if (available) {
    const label = compact || !pageCount ? 'PDF' : `PDF (${pageCount} page${pageCount === 1 ? '' : 's'})`
    return (
      <a className="status-badge status-badge--success" href={href} target="_blank" rel="noreferrer">
        {label}
      </a>
    )
  }
  return (
    <span className="status-badge status-badge--neutral">No PDF</span>
  )
}
