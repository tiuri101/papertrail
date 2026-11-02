import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { isJobActive } from '../jobs/jobStatus'

export interface BookmarkItem {
  publicationId: string
  projectId: string
  title: string
  authors: string | null
  publicationYear: number | null
  venue: string | null
  doi: string | null
  publisherUrl: string | null
  bookmarkedAt: string
}

export const bookmarksQueryKey = ['bookmarks'] as const
export const bookmarkListQueryKey = ['bookmarks', 'list'] as const

export function projectBookmarkIdsQueryKey(projectId: string) {
  return ['bookmarks', 'project', projectId] as const
}

/**
 * The ids of the current user's bookmarked publications in one project, shared
 * by every bookmark toggle on the page through the query cache, so a list of a
 * hundred rows costs one request rather than a hundred.
 */
export function useProjectBookmarkIds(projectId: string) {
  return useQuery({
    queryKey: projectBookmarkIdsQueryKey(projectId),
    queryFn: async () => {
      const response = await apiRequest<{ publicationIds?: unknown }>(
        `/api/v1/projects/${projectId}/bookmarks/ids`,
      )
      const ids = response?.publicationIds
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []
    },
    enabled: Boolean(projectId),
  })
}

export function useBookmarkList() {
  return useQuery({
    queryKey: bookmarkListQueryKey,
    queryFn: () => apiRequest<BookmarkItem[]>('/api/v1/bookmarks'),
  })
}

export interface BookmarkExportStatus {
  jobId: string
  status: string
  errorMessage: string | null
  filename: string | null
  publicationCount: number | null
}

export function bookmarkExportDownloadHref(jobId: string): string {
  return `/api/v1/bookmarks/exports/${jobId}/download`
}

export function useRemoveBookmarks() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (publicationIds: string[]) =>
      apiRequest<{ removedCount: number }>('/api/v1/bookmarks/remove', {
        method: 'POST',
        body: JSON.stringify({ publicationIds }),
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: bookmarksQueryKey }),
  })
}

/** Queues a metadata.bib + PDFs bundle of the given bookmarks (or of all of
 * them, for `null`); the worker builds it in the background. */
export function useCreateBookmarkExport() {
  return useMutation({
    mutationFn: (publicationIds: string[] | null) =>
      apiRequest<{ jobId: string }>('/api/v1/bookmarks/exports', {
        method: 'POST',
        body: JSON.stringify(publicationIds ? { publicationIds } : {}),
      }),
  })
}

export function useBookmarkExportStatus(jobId: string | null) {
  return useQuery({
    queryKey: ['bookmarks', 'export', jobId],
    queryFn: () => apiRequest<BookmarkExportStatus>(`/api/v1/bookmarks/exports/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return !query.state.error && (!status || isJobActive(status)) ? 1500 : false
    },
  })
}

export function useToggleBookmark(projectId: string) {
  const queryClient = useQueryClient()
  const idsKey = projectBookmarkIdsQueryKey(projectId)
  return useMutation({
    mutationFn: ({ publicationId, bookmarked }: { publicationId: string; bookmarked: boolean }) =>
      apiRequest<void>(`/api/v1/projects/${projectId}/publications/${publicationId}/bookmark`, {
        method: bookmarked ? 'PUT' : 'DELETE',
      }),
    onMutate: async ({ publicationId, bookmarked }) => {
      await queryClient.cancelQueries({ queryKey: idsKey })
      const previous = queryClient.getQueryData<string[]>(idsKey)
      queryClient.setQueryData<string[]>(idsKey, (current = []) =>
        bookmarked
          ? current.includes(publicationId)
            ? current
            : [...current, publicationId]
          : current.filter((id) => id !== publicationId),
      )
      return { previous }
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(idsKey, context?.previous)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: bookmarksQueryKey }),
  })
}
