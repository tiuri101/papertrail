import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

const outcomes = ['include', 'exclude', 'uncertain', 'duplicate']

export function ConflictResolutionPage() {
  const { projectId = '', stage = 'title_abstract' } = useParams()
  const queryClient = useQueryClient()
  const conflicts = useQuery({
    queryKey: ['conflicts', projectId, stage],
    queryFn: () => apiRequest<{ publicationIds: string[] }>(
      `/api/v1/projects/${projectId}/screening/${stage}/conflicts`,
    ),
  })
  const resolve = useMutation({
    mutationFn: ({ publicationId, outcome }: { publicationId: string; outcome: string }) =>
      apiRequest(
        `/api/v1/projects/${projectId}/screening/${stage}/publications/${publicationId}/final`,
        {
          method: 'POST',
          body: JSON.stringify({
            outcome,
            resolutionMethod: 'admin_consensus',
            note: null,
          }),
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: ['conflicts', projectId, stage],
    }),
  })

  return (
    <main className="page">
      <h1>Conflict resolution</h1>
      {conflicts.error ? <p className="error" role="alert">{conflicts.error.message}</p> : null}
      {resolve.error ? <p className="error" role="alert">{resolve.error.message}</p> : null}
      <p>{conflicts.data?.publicationIds.length ?? 0} unresolved publications</p>
      <ul>
        {conflicts.data?.publicationIds.map((publicationId) => (
          <li className="card" key={publicationId}>
            <p>{publicationId}</p>
            <div className="toolbar">
              {outcomes.map((outcome) => (
                <button
                  type="button"
                  key={outcome}
                  onClick={() => resolve.mutate({ publicationId, outcome })}
                  disabled={resolve.isPending}
                >
                  {outcome}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}
