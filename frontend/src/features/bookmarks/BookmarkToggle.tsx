import { IconButton, type ButtonSize } from '../../components/Button'
import { IconBookmark, IconBookmarkFilled } from '../../components/icons'
import { cn } from '../../lib/cn'
import { useProjectBookmarkIds, useToggleBookmark } from './useBookmarks'

interface BookmarkToggleProps {
  projectId: string
  publicationId: string
  size?: ButtonSize
  className?: string
}

/** Adds or removes the current user's private bookmark on one publication. */
export function BookmarkToggle({ projectId, publicationId, size = 'sm', className }: BookmarkToggleProps) {
  const ids = useProjectBookmarkIds(projectId)
  const toggle = useToggleBookmark(projectId)
  const bookmarked = Boolean(ids.data?.includes(publicationId))
  const label = bookmarked ? 'Remove bookmark' : 'Bookmark'

  return (
    <IconButton
      size={size}
      aria-label={label}
      aria-pressed={bookmarked}
      title={label}
      disabled={!ids.isSuccess}
      className={cn('shrink-0', bookmarked && 'text-primary! hover:not-disabled:text-primary-strong!', className)}
      onClick={(event) => {
        // Rows navigate on click; a bookmark toggle must never open the paper.
        event.stopPropagation()
        toggle.mutate({ publicationId, bookmarked: !bookmarked })
      }}
    >
      {bookmarked ? <IconBookmarkFilled /> : <IconBookmark />}
    </IconButton>
  )
}
