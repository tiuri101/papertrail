import { useQuery } from '@tanstack/react-query'

import { apiRequest } from '../api/client'

export function useHighlightKeywords(projectId: string): string[] {
  const query = useQuery({
    queryKey: ['highlight-keywords', projectId],
    queryFn: () => apiRequest<{ keywords: string[] }>(
      `/api/v1/projects/${projectId}/highlight-keywords`,
    ),
    enabled: Boolean(projectId),
  })
  return query.data?.keywords ?? []
}
