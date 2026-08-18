export function PublisherLinkPill({ url }: { url: string }) {
  return (
    <a
      className="status-badge status-badge--primary"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
    >
      Publisher link
    </a>
  )
}
