export const stages = [
  'draft',
  'duplicate_review',
  'title_abstract_screening',
  'full_text_screening',
  'extraction_quality',
]

export const stageOrder = [...stages, 'completed']

export const activeStages = stages.filter((stage) => stage !== 'draft')

export function humanizeStage(stage: string): string {
  return stage
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
