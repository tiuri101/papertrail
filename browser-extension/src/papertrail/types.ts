export interface StoredConnection {
  serverUrl: string
  agentToken: string
  agentId: string
  displayName: string
  extensionVersion: string
}

export interface ClaimedPublication {
  id: string
  title: string
  doi: string | null
  publisherUrl: string | null
}

export interface ClaimedJob {
  jobId: string
  batchId: string
  projectId: string
  publication: ClaimedPublication
  maxPdfBytes: number
  leaseUntil: string
}

export type TerminalFailureStatus =
  | 'needs_authentication'
  | 'not_found'
  | 'access_denied'
  | 'invalid_response'
  | 'failed'

export type ReportableJobStatus = 'retrieving' | 'uploading' | TerminalFailureStatus

export interface JobStateUpdate {
  status: ReportableJobStatus
  httpStatus?: number
  errorCode?: string
  errorMessage?: string
  resolvedLandingUrl?: string
  resolvedPdfUrl?: string
}

export interface JobResult {
  id: string
  batchId: string
  status: string
  errorCode: string | null
  errorMessage: string | null
  leaseUntil: string | null
}

// --- Manual capture (ad-hoc tab capture, no PdfRetrievalJob) ------------------------

export interface AgentProject {
  id: string
  name: string
}

export interface PublicationPickerResult {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  doi: string | null
}

export interface PdfDetectResult {
  detectedDoi: string | null
  detectedTitle: string | null
  detectedAuthors: string | null
  detectedYear: number | null
  match: PublicationPickerResult | null
  ambiguous: boolean
}

export interface CaptureAttachResult {
  documentId: string
  publicationId: string
  title: string
}

export interface NewPublicationFields {
  title: string
  authors?: string
  publicationYear?: number
  doi?: string
}

export interface CreatedPublication {
  id: string
  title: string
}
