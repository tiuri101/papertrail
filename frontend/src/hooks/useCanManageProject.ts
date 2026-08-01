import { useQuery } from '@tanstack/react-query'

import { apiRequest } from '../api/client'

interface ProjectManageFlag {
  canManage: boolean
}

/**
 * Shares the ['project', projectId] cache entry with every other component
 * that fetches the project detail, so this doesn't add an extra request.
 */
export function useCanManageProject(projectId: string): boolean {
  const query = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectManageFlag>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  return query.data?.canManage ?? false
}

/**
 * Like useCanManageProject, but also reports whether the check is still in
 * flight -- for pages that gate their entire render on it, so they can show
 * a loading state instead of flashing "restricted" before the first
 * response arrives.
 */
export function useProjectManageState(projectId: string): { canManage: boolean; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectManageFlag>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  return { canManage: query.data?.canManage ?? false, isLoading: query.isLoading }
}
