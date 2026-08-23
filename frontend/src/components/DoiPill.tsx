import { BadgeLink } from './Badge'

export function DoiPill({ doi }: { doi: string | null | undefined }) {
  if (!doi) return null
  return (
    <BadgeLink variant="primary" href={`https://doi.org/${doi}`} target="_blank" rel="noopener noreferrer">
      DOI
    </BadgeLink>
  )
}
