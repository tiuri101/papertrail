export function DoiPill({ doi }: { doi: string | null | undefined }) {
  if (!doi) return null
  return (
    <a
      className="status-badge status-badge--primary"
      href={`https://doi.org/${doi}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      DOI
    </a>
  )
}
