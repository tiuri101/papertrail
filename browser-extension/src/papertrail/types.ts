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
