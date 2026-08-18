import { useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'

export interface RqEvidenceItem {
  page: number
  quote: string
  section: string | null
  verified: boolean
}

export interface RqSourceRef {
  publicationId: string
  publicationTitle: string
  sourceType: 'extraction' | 'quality'
  fieldKey: string
  label: string
  value: unknown
  evidence: RqEvidenceItem[]
}

export interface RqStatement {
  claim: string
  sourceIds: string[]
}

export interface RqRun {
  id: string
  status: string
  generatedAt: string | null
  statements: RqStatement[]
  limitations: string[]
  sourceRefs: Record<string, RqSourceRef>
  model: string
  promptVersion: string
  error: string | null
}

export interface RqAnalysisResponse {
  researchQuestionId: string
  researchQuestionText: string
  synthesisEnabled: boolean
  latestRun: RqRun | null
  isStale: boolean
}

export interface ProjectResearchQuestions {
  researchQuestions: { id: string; text: string }[]
}

export function useResearchQuestions(projectId: string) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectResearchQuestions>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
}

export function useRqAnalysis(projectId: string, researchQuestionId: string) {
  return useQuery({
    queryKey: ['rq-analysis', projectId, researchQuestionId],
    queryFn: () => apiRequest<RqAnalysisResponse>(
      `/api/v1/projects/${projectId}/research-questions/${researchQuestionId}/analysis`,
    ),
    enabled: Boolean(projectId && researchQuestionId),
  })
}
