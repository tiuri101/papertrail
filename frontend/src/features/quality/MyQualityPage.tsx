import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface CompletedQualityAssessment {
  id: string
  publicationId: string
  publication: {
    title: string
    authors: string | null
    publicationYear: number | null
  }
  completedAt: string | null
  version: number
  totalScore: number | null
}

export function MyQualityPage() {
  const { projectId = '' } = useParams()
  const query = useQuery({
    queryKey: ['my-quality-assessments', projectId],
    queryFn: () => apiRequest<CompletedQualityAssessment[]>(`/api/v1/projects/${projectId}/quality/mine`),
    enabled: Boolean(projectId),
  })

  return (
    <main className="page">
      <h1>My Submitted Quality Assessments</h1>
      <p className="muted">
        Publications you have already assessed. Open one to revisit and correct your answers —
        each correction is saved as a new, separately tracked version.
      </p>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {query.isLoading ? <p>Loading…</p> : null}
      {query.data && query.data.length === 0 ? (
        <p>You have not submitted any quality assessments yet.</p>
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
            {entry.totalScore !== null ? ` · Total score ${entry.totalScore}` : ''}
            {entry.completedAt ? ` · Submitted ${new Date(entry.completedAt).toLocaleString()}` : ''}
          </p>
          <Link to={`/projects/${projectId}/quality/review/${entry.id}`}>
            Review and edit
          </Link>
        </article>
      ))}
    </main>
  )
}
