import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface Publication {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  doi: string | null
}

export function PublicationsPage() {
  const { projectId = '' } = useParams()
  const query = useQuery({
    queryKey: ['publications', projectId],
    queryFn: () => apiRequest<Publication[]>(
      `/api/v1/projects/${projectId}/publications`,
    ),
  })

  return (
    <main className="page">
      <h1>Publications</h1>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      <ul>
        {query.data?.map((publication) => (
          <li key={publication.id}>
            <strong>{publication.title}</strong>
            {' — '}{publication.authors ?? 'Unknown authors'}
            {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
            {publication.doi ? (
              <> <a href={`https://doi.org/${publication.doi}`}>DOI</a></>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  )
}
