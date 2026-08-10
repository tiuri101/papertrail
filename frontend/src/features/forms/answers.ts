export function isAnswered(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

// Checkboxes and multi-selects render an unanswered field the same way they
// render an explicit "false"/"none selected" answer (unchecked boxes), so a
// raw comparison of the stored value against an LLM suggestion would miss
// that the reviewer's default already agrees with a suggested false/empty
// value. Normalize both sides the same way DynamicField does before
// comparing.
export function normalizeForSuggestionMatch(fieldType: string, value: unknown): unknown {
  if (fieldType === 'checkbox') return Boolean(value)
  if (fieldType === 'multiple_select') return Array.isArray(value) ? value : []
  return value
}
