import { IconCheckCircle, IconXCircle } from './icons'

export function PdfAvailabilityPill({ available, href, pageCount }: {
  available: boolean
  href: string
  pageCount?: number | null
}) {
  if (available) {
    return (
      <a className="status-badge status-badge--success" href={href} target="_blank" rel="noreferrer">
        <IconCheckCircle /> PDF{pageCount ? ` (${pageCount} page${pageCount === 1 ? '' : 's'})` : ''}
      </a>
    )
  }
  return (
    <span className="status-badge status-badge--neutral"><IconXCircle /> No PDF</span>
  )
}
