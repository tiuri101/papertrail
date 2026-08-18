import { useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'

export interface ConfusionMatrixRow {
  actual: string
  counts: Record<string, number>
}

export interface ConfusionMatrix {
  categories: string[]
  rows: ConfusionMatrixRow[]
}

export interface PairwiseAgreement {
  reviewerA: string
  reviewerB: string
  publicationsCompared: number
  agreeing: number
  rawAgreementRate: number | null
  cohensKappa: number | null
  confusionMatrix: ConfusionMatrix
}

export interface CriterionAgreement {
  criterionId: string
  criterionText: string
  comparableDecisions: number
  rawAgreementRate: number | null
  disagreementCount: number
  kappa: number | null
}

export interface DisagreementTrendPoint {
  bucketStart: string
  comparablePublications: number
  agreementCount: number
  disagreementCount: number
  agreementRate: number
}

export interface ReviewerSummaryEntry {
  reviewer: string
  originalDecisions: number
  revisedDecisions: number
  revisionRate: number | null
  titleAbstractCount: number
  fullTextCount: number
}

export interface ReviewerAnalysisResponse {
  stage: string
  overall: {
    comparingReviewerCount: number
    publicationsWithCompleteSet: number
    totalOriginalDecisions: number
    rawAgreementRate: number | null
    publicationDisagreementRate: number | null
    uncertainDecisionRate: number | null
    nonAgreementResolutionCount: number
    nonAgreementResolutionRate: number | null
    revisionRate: number | null
  }
  pairwise: PairwiseAgreement[]
  multiReviewer: {
    kappa: number | null
    unavailableReason: string | null
  }
  criteria: CriterionAgreement[]
  disagreementTrend: DisagreementTrendPoint[]
  reviewerSummary: ReviewerSummaryEntry[]
}

export function useReviewerAnalysis(projectId: string, stage: 'title_abstract' | 'full_text') {
  return useQuery({
    queryKey: ['reviewer-analysis', projectId, stage],
    queryFn: () => apiRequest<ReviewerAnalysisResponse>(
      `/api/v1/projects/${projectId}/analysis/reviewer-analysis/${stage}`,
    ),
    enabled: Boolean(projectId),
  })
}
