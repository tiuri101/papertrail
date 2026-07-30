import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { BackgroundJob, hasActiveJob } from './jobStatus'

export function JobsPage() {
  const { projectId = '' } = useParams()
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 3000 : false),
  })

  return (
    <main className="page">
      <h1>Jobs</h1>
      {jobs.error ? <p className="error" role="alert">{jobs.error.message}</p> : null}
      {jobs.isLoading ? <p>Loading…</p> : null}
      {jobs.data && jobs.data.length === 0 ? <p className="muted">No background jobs have run for this project yet.</p> : null}
      <ul className="card-list">
        {jobs.data?.map((job) => (
          <li className="card" key={job.id}>
            <p>
              <strong>{job.jobType}</strong>
              {' — '}{job.status}
              {job.progressTotal ? ` (${job.progressCurrent}/${job.progressTotal})` : ''}
            </p>
            {job.progressMessage ? <p className="muted">{job.progressMessage}</p> : null}
            {job.errorMessage ? <p className="error" role="alert">{job.errorMessage}</p> : null}
            <p className="muted">
              Queued {new Date(job.createdAt).toLocaleString()}
              {job.completedAt ? ` — completed ${new Date(job.completedAt).toLocaleString()}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </main>
  )
}
