import type { LlmEvidenceItem } from '../llm/LlmTaskComponents'

export interface ValidationResult {
  fieldKey: string
  fieldLabel: string
  value: unknown
  assessment: 'supported' | 'contradicted' | 'uncertain' | 'not_verifiable'
  explanation: string
  evidence: LlmEvidenceItem[]
  evidenceValidationStatus: string
}
