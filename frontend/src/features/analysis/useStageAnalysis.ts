import { useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import type { StageAnalysisResponse } from './types'

export function useStageAnalysis<TStats>(projectId: string, stage: string, enabled = true) {
  return useQuery({
    queryKey: ['analysis', projectId, stage],
    queryFn: () => apiRequest<StageAnalysisResponse<TStats>>(
      `/api/v1/projects/${projectId}/analysis/${stage}`,
    ),
    enabled: Boolean(projectId && enabled),
  })
}
