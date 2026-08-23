import type { PdfSummary } from './PdfMatchReview'

export interface UploadResult {
  importBatchId: string
  summary: PdfSummary
}
