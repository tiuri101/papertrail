type TaskAllocationMode = 'pre_assigned' | 'claim'

export interface QualityConfig {
  enabled: boolean
  mode: string
  aggregation: string
  allocationMode: TaskAllocationMode
}
