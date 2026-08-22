export interface ReviewForm {
  id: string
  name: string
  kind: string
  isTemplate: boolean
  activeVersionId: string | null
}

export interface FormField {
  id: string
  stableKey: string
  label: string
  fieldType: string
  required: boolean
  position: number
  isArchived: boolean
  options: string[]
  scoring: Record<string, unknown>
}
