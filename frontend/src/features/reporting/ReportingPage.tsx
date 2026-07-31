import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'

interface ExportArtifact {
  id: string
  type: string
  filename: string
  createdAt: string
}

export function ReportingPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const prisma = useQuery({
    queryKey: ['prisma', projectId],
    queryFn: () => apiRequest<Record<string, unknown>>(
      `/api/v1/projects/${projectId}/prisma`,
    ),
  })
  const exportsQuery = useQuery({
    queryKey: ['exports', projectId],
    queryFn: () => apiRequest<ExportArtifact[]>(
      `/api/v1/projects/${projectId}/exports`,
    ),
  })
  const jobs = useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => apiRequest<BackgroundJob[]>(`/api/v1/projects/${projectId}/jobs`),
    enabled: Boolean(projectId) && Boolean(pendingJobId),
    refetchInterval: (query) => (hasActiveJob(query.state.data) ? 2000 : false),
  })
  const pendingJob = pendingJobId ? findJob(jobs.data, pendingJobId) : undefined

  useEffect(() => {
    if (pendingJob && !isJobActive(pendingJob.status)) {
      queryClient.invalidateQueries({ queryKey: ['exports', projectId] })
    }
  }, [pendingJob, projectId, queryClient])

  const createExport = useMutation({
    mutationFn: (exportType: string) => apiRequest<{ jobId: string }>(
      `/api/v1/projects/${projectId}/exports`,
      {
        method: 'POST',
        body: JSON.stringify({ exportType, scope: 'included' }),
      },
    ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['exports', projectId] })
      if (result?.jobId) setPendingJobId(result.jobId)
    },
  })

  const queryError = prisma.error ?? exportsQuery.error

  return (
    <main className="page">
      <h1>Reporting and exports</h1>
      {queryError ? <p className="error" role="alert">{queryError.message}</p> : null}
      {createExport.error ? <p className="error" role="alert">{createExport.error.message}</p> : null}
      {pendingJob && isJobActive(pendingJob.status) ? <p className="muted">Generating export…</p> : null}
      {pendingJob && pendingJob.status === 'failed' ? (
        <p className="error" role="alert">
          Export failed{pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
        </p>
      ) : null}
      <section className="card">
        <h2>PRISMA 2020 counts</h2>
        <pre>{JSON.stringify(prisma.data, null, 2)}</pre>
      </section>
      <div className="toolbar">
        <button
          type="button"
          onClick={() => createExport.mutate('prisma_svg')}
          disabled={createExport.isPending}
        >
          Generate PRISMA SVG
        </button>
        <button
          type="button"
          onClick={() => createExport.mutate('xlsx')}
          disabled={createExport.isPending}
        >
          Generate Excel workbook
        </button>
        <button
          type="button"
          onClick={() => createExport.mutate('prisma_tables')}
          disabled={createExport.isPending}
        >
          Generate PRISMA supporting tables
        </button>
        <button
          type="button"
          onClick={() => createExport.mutate('bibtex')}
          disabled={createExport.isPending}
        >
          Generate BibTeX
        </button>
      </div>
      <h2>Available exports</h2>
      <ul>
        {exportsQuery.data?.map((artifact) => (
          <li key={artifact.id}>
            <a href={`/api/v1/projects/${projectId}/exports/${artifact.id}/download`}>
              {artifact.filename}
            </a>
            {' — '}{artifact.type}
          </li>
        ))}
      </ul>
    </main>
  )
}
