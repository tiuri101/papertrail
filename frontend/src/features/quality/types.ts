type TaskAllocationMode = 'pre_assigned' | 'claim'

// Closed sets, matching backend/app/quality/models.py (QualityMode /
// QualityAggregation). These were plain `string` before, which let the UI
// construct a value the API has never accepted.
export const QUALITY_MODES = ['qualitative', 'numeric', 'both'] as const
export type QualityMode = (typeof QUALITY_MODES)[number]

export const QUALITY_AGGREGATIONS = ['sum', 'average', 'weighted_average'] as const
export type QualityAggregation = (typeof QUALITY_AGGREGATIONS)[number]

export const QUALITY_MODE_LABELS: Record<QualityMode, string> = {
  qualitative: 'Qualitative only',
  numeric: 'Numerical scoring only',
  both: 'Both',
}

export const QUALITY_AGGREGATION_LABELS: Record<QualityAggregation, string> = {
  sum: 'Simple sum',
  average: 'Average',
  weighted_average: 'Weighted average',
}

export interface QualityConfig {
  enabled: boolean
  mode: QualityMode
  aggregation: QualityAggregation
  allocationMode: TaskAllocationMode
}
