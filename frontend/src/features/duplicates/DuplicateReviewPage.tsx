import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface Candidate {
  id: string
  publicationAId: string
  publicationBId: string
  matchReasons: string[]
  confidence: number
  status: string
}

export function DuplicateReviewPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const candidates = useQuery({
    queryKey: ['duplicates', projectId],
    queryFn: () => apiRequest<Candidate[]>(
      `/api/v1/projects/${projectId}/duplicates`,
    ),
  })
  const refreshCandidates = () => queryClient.invalidateQueries({
    queryKey: ['duplicates', projectId],
  })
  const notDuplicate = useMutation({
    mutationFn: (id: string) => apiRequest(
      `/api/v1/projects/${projectId}/duplicates/${id}/not-duplicate`,
      {
        method: 'POST',
        body: JSON.stringify({ note: null }),
      },
    ),
    onSuccess: refreshCandidates,
  })
  const merge = useMutation({
    mutationFn: ({ id, canonical }: { id: string; canonical: string }) =>
      apiRequest(`/api/v1/projects/${projectId}/duplicates/${id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ canonicalPublicationId: canonical }),
      }),
    onSuccess: refreshCandidates,
  })

  const mutationError = notDuplicate.error ?? merge.error

  return (
    <main className="page">
      <h1>Duplicate review</h1>
      {candidates.error ? <p className="error" role="alert">{candidates.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      <ul>
        {candidates.data?.map((candidate) => (
          <li className="card" key={candidate.id}>
            <p>{candidate.publicationAId} ↔ {candidate.publicationBId}</p>
            <p>
              {candidate.matchReasons.join(', ')} — {Math.round(candidate.confidence * 100)}%
              {' — '}{candidate.status}
            </p>
            {candidate.status === 'unresolved' ? (
              <div className="toolbar">
                <button
                  type="button"
                  onClick={() => notDuplicate.mutate(candidate.id)}
                  disabled={notDuplicate.isPending || merge.isPending}
                >
                  Not a duplicate
                </button>
                <button
                  type="button"
                  onClick={() => merge.mutate({
                    id: candidate.id,
                    canonical: candidate.publicationAId,
                  })}
                  disabled={notDuplicate.isPending || merge.isPending}
                >
                  Merge into A
                </button>
                <button
                  type="button"
                  onClick={() => merge.mutate({
                    id: candidate.id,
                    canonical: candidate.publicationBId,
                  })}
                  disabled={notDuplicate.isPending || merge.isPending}
                >
                  Merge into B
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  )
}
