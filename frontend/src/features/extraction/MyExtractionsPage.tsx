import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface CompletedExtraction {
  id: string
  publicationId: string
  publication: {
    title: string
    authors: string | null
    publicationYear: number | null
  }
  completedAt: string | null
  version: number
}

export function MyExtractionsPage() {
  const { projectId = '' } = useParams()
  const query = useQuery({
    queryKey: ['my-extractions', projectId],
    queryFn: () => apiRequest<CompletedExtraction[]>(`/api/v1/projects/${projectId}/extraction/mine`),
    enabled: Boolean(projectId),
  })

  return (
    <main className="page">
      <h1>My Submitted Extractions</h1>
      <p className="muted">
        Publications you have already extracted. Open one to revisit and correct your answers —
        each correction is saved as a new, separately tracked version.
      </p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data && query.data.length === 0 ? (
        <p>You have not submitted any extractions yet.</p>
      ) : null}
      {query.data?.map((entry) => (
        <article className="card" key={entry.id}>
          <h2>{entry.publication.title}</h2>
          <p className="muted">
            {entry.publication.authors ?? 'Unknown authors'}
            {entry.publication.publicationYear ? ` (${entry.publication.publicationYear})` : ''}
          </p>
          <p className="muted">
            Version {entry.version}
            {entry.completedAt ? ` · Submitted ${new Date(entry.completedAt).toLocaleString()}` : ''}
          </p>
          <Link to={`/projects/${projectId}/extraction/review/${entry.id}`}>
            Review and edit
          </Link>
        </article>
      ))}
    </main>
  )
}
