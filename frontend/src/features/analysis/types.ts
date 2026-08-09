export interface BreakdownItem {
  label: string
  count: number
}

export interface HistogramBin {
  rangeStart: number
  rangeEnd: number
  count: number
}

export interface NumericStats {
  min: number
  max: number
  mean: number
  median: number
  histogram: HistogramBin[]
}

export interface StageNarrative {
  summary: string
  generatedAt: string
}

export interface StageAnalysisResponse<TStats> {
  stats: TStats
  narrative: StageNarrative | null
  isStale: boolean
}

export interface DuplicateReviewStats {
  recordsIdentified: number
  duplicatesRemoved: number
  uniqueRecordsRemaining: number
  matchReasonCounts: BreakdownItem[]
}

export interface TitleAbstractStats {
  recordsScreened: number
  recordsExcluded: number
  outcomeCounts: BreakdownItem[]
  exclusionReasonCounts: BreakdownItem[]
}

export interface FullTextStats {
  reportsSought: number
  reportsNotRetrieved: number
  reportsAssessed: number
  includedPublications: number
  retrievalStatusCounts: BreakdownItem[]
  outcomeCounts: BreakdownItem[]
  exclusionReasonCounts: BreakdownItem[]
}

export interface OptionCount {
  option: string
  count: number
}

export interface FieldStats {
  id: string
  stableKey: string
  label: string
  fieldType: string
  source: string
  answeredCount: number
  totalCount: number
  optionCounts?: OptionCount[]
  numericStats?: NumericStats
}

export interface ExtractionQualityStats {
  totalPublications: number
  fields: FieldStats[]
  qualityTotalScore?: NumericStats | null
}
