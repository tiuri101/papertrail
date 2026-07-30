import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface Retrieval {
  id: string
  publicationId: string
  status: string
  note: string | null
}

const statuses = [
  'not_yet_sought',
  'available',
  'requested',
  'not_found',
  'inaccessible',
]

export function FullTextPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const retrievals = useQuery({
    queryKey: ['fulltext', projectId],
    queryFn: () => apiRequest<Retrieval[]>(
      `/api/v1/projects/${projectId}/full-text`,
    ),
  })
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiRequest(`/api/v1/projects/${projectId}/full-text/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: ['fulltext', projectId],
    }),
  })

  return (
    <main className="page">
      <h1>Full-text retrieval</h1>
      {retrievals.error ? <p className="error" role="alert">{retrievals.error.message}</p> : null}
      {update.error ? <p className="error" role="alert">{update.error.message}</p> : null}
      <ul>
        {retrievals.data?.map((retrieval) => (
          <li className="card" key={retrieval.id}>
            <strong>{retrieval.publicationId}</strong>
            <label>
              Retrieval status for {retrieval.publicationId}
              <select
                value={retrieval.status}
                onChange={(event) => update.mutate({
                  id: retrieval.id,
                  status: event.target.value,
                })}
              >
                {statuses.map((status) => (
                  <option value={status} key={status}>{status}</option>
                ))}
              </select>
            </label>
            {retrieval.note ? <p>{retrieval.note}</p> : null}
          </li>
        ))}
      </ul>
    </main>
  )
}
