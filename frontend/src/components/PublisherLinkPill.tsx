import { BadgeLink } from './Badge'

export function PublisherLinkPill({ url }: { url: string }) {
  return (
    <BadgeLink variant="primary" href={url} target="_blank" rel="noopener noreferrer">
      Publisher link
    </BadgeLink>
  )
}
