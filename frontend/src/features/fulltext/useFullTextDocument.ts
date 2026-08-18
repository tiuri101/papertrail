import { useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'

export interface FullTextDocumentUser {
  id: string
  displayName: string
}

export interface FullTextPdfDocument {
  id: string
  originalFilename: string
  fileSize: number
  pageCount?: number | null
  uploadedAt: string
  uploadedBy: FullTextDocumentUser | null
  isActive: boolean
  removedAt: string | null
}

export interface FullTextDocumentState {
  available: boolean
  document: FullTextPdfDocument | null
}

export function fullTextDocumentEndpoint(projectId: string, publicationId: string) {
  return `/api/v1/projects/${projectId}/publications/${publicationId}/full-text`
}

export function fullTextDocumentQueryKey(projectId: string, publicationId: string) {
  return ['full-text-document', projectId, publicationId]
}

export function useFullTextDocument(projectId: string, publicationId: string) {
  return useQuery({
    queryKey: fullTextDocumentQueryKey(projectId, publicationId),
    queryFn: () => apiRequest<FullTextDocumentState>(fullTextDocumentEndpoint(projectId, publicationId)),
    enabled: Boolean(projectId && publicationId),
  })
}
