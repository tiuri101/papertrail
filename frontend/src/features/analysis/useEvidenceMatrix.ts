import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'

export type EvidenceState = 'answered' | 'missing' | 'pending_reconciliation'

export interface EvidenceMatrixColumn {
  key: string
  label: string
  fieldType: string
  source: 'extraction' | 'quality'
  options: unknown[] | null
}

export interface EvidenceMatrixCell {
  value: unknown
  state: EvidenceState
  hasEvidence: boolean
}

export interface EvidenceMatrixItem {
  publication: {
    id: string
    title: string
    authors: string | null
    publicationYear: number | null
  }
  cells: Record<string, EvidenceMatrixCell>
}

export interface EvidenceMatrixResponse {
  columns: EvidenceMatrixColumn[]
  items: EvidenceMatrixItem[]
  total: number
  page: number
  pageSize: number
  qualityEnabled: boolean
}

export type EvidenceFilterPredicate =
  | { type: 'presence'; state: EvidenceState }
  | { type: 'text'; contains: string }
  | { type: 'categorical'; values: string[] }
  | { type: 'multi_select'; anyOf: string[] }
  | { type: 'numeric'; min?: number; max?: number }

export interface EvidenceCellDetail {
  publication: { id: string; title: string }
  fieldKey: string
  label: string
  fieldType: string
  sourceType: 'extraction' | 'quality'
  value: unknown
  state: EvidenceState
  resolutionMethod: string | null
  resolvedAt: string | null
  evidence: { page: number; quote: string; section: string | null; verified: boolean }[]
}

export function useEvidenceMatrix(
  projectId: string,
  params: {
    search: string
    filters: Record<string, EvidenceFilterPredicate>
    page: number
    pageSize: number
  },
) {
  return useQuery({
    queryKey: ['evidence-matrix', projectId, params],
    queryFn: () =>
      apiRequest<EvidenceMatrixResponse>(`/api/v1/projects/${projectId}/evidence-matrix`, {
        method: 'POST',
        body: JSON.stringify({
          search: params.search || null,
          filters: params.filters,
          page: params.page,
          pageSize: params.pageSize,
        }),
      }),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  })
}

export function useEvidenceCellDetail(
  projectId: string,
  selection: { publicationId: string; sourceType: string; fieldKey: string } | null,
) {
  return useQuery({
    queryKey: ['evidence-matrix-cell', projectId, selection],
    queryFn: () =>
      apiRequest<EvidenceCellDetail>(
        `/api/v1/projects/${projectId}/evidence-matrix/cell/` +
          `${selection!.publicationId}/${selection!.sourceType}/${selection!.fieldKey}`,
      ),
    enabled: Boolean(projectId && selection),
  })
}
