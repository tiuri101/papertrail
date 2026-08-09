export const fieldTypes = [
  'short_text',
  'long_text',
  'number',
  'checkbox',
  'single_select',
  'multiple_select',
  'date',
  'url',
  'rating',
]

export const fieldTypeLabels: Record<string, string> = {
  short_text: 'Short text',
  long_text: 'Long text',
  number: 'Number',
  checkbox: 'Checkbox',
  single_select: 'Single select',
  multiple_select: 'Multiple select',
  date: 'Date',
  url: 'URL',
  rating: 'Rating',
}

export const selectFieldTypes = new Set(['single_select', 'multiple_select'])
export const weightedFieldTypes = new Set(['number', 'rating'])

export function parseOptions(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

export function describeRatingScale(options: string[]): string {
  if (options.length !== 2) return '1-5'
  return `${options[0]}-${options[1]}`
}

export function buildScoring(params: {
  isQualityForm: boolean
  fieldType: string
  weight: string
  options: string[]
  optionScores: Record<string, string>
  trueScore: string
  falseScore: string
}): Record<string, unknown> {
  if (!params.isQualityForm) return {}
  if (weightedFieldTypes.has(params.fieldType)) {
    return params.weight.trim() ? { weight: Number(params.weight) } : {}
  }
  if (params.fieldType === 'single_select') {
    const values: Record<string, number> = {}
    for (const option of params.options) {
      const raw = params.optionScores[option]
      if (raw !== undefined && raw.trim() !== '') values[option] = Number(raw)
    }
    return Object.keys(values).length ? { values } : {}
  }
  if (params.fieldType === 'checkbox') {
    const scoring: Record<string, number> = {}
    if (params.trueScore.trim()) scoring['true'] = Number(params.trueScore)
    if (params.falseScore.trim()) scoring['false'] = Number(params.falseScore)
    return scoring
  }
  return {}
}
