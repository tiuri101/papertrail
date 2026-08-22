import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CountPill } from '../../components/CountPill'
import { IconDownload, IconTrash } from '../../components/icons'
import { useCanManagePublications } from '../../hooks/useCanManageProject'
import { isJobActive } from '../jobs/jobStatus'
import { usePendingJob } from '../jobs/usePendingJob'
import { StageEyebrow } from '../projects/StageEyebrow'

interface ExportArtifact {
  id: string
  type: string
  filename: string
  createdAt: string
}

const exportOptions = [
  {
    type: 'xlsx',
    title: 'Excel Workbook',
    description: 'A complete, analysis-ready workbook with review decisions and extracted data.',
    buttonLabel: 'Generate Excel Workbook',
  },
  {
    type: 'parquet',
    title: 'Parquet Dataset',
    description: 'A compact, typed dataset for Python, R, DuckDB, Spark, and dashboard workflows.',
    buttonLabel: 'Generate Parquet Dataset',
  },
  {
    type: 'json',
    title: 'JSON Export',
    description: 'A structured export that preserves project results for APIs and application workflows.',
    buttonLabel: 'Generate JSON Export',
  },
  {
    type: 'csv',
    title: 'CSV Dataset',
    description: 'A common tabular export for Python, R, spreadsheets, and dashboard tools.',
    buttonLabel: 'Generate CSV Dataset',
  },
  {
    type: 'prisma_svg',
    title: 'PRISMA Flow Diagram',
    description: 'A publication-ready SVG of the current PRISMA 2020 flow diagram.',
    buttonLabel: 'Generate PRISMA SVG',
  },
  {
    type: 'prisma_tables',
    title: 'PRISMA Tables',
    description: 'The structured counts behind the diagram for reporting and verification.',
    buttonLabel: 'Generate PRISMA Tables',
  },
  {
    type: 'bibtex',
    title: 'BibTeX Library',
    description: 'Citation records for every publication included in the final review.',
    buttonLabel: 'Generate BibTeX',
  },
] as const

function humanizeKey(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase())
}

function formatArtifactType(value: string) {
  return humanizeKey(value)
    .replace('Prisma', 'PRISMA')
    .replace('Xlsx', 'Excel')
    .replace('Pdf', 'PDF')
    .replace('Json', 'JSON')
    .replace('Csv', 'CSV')
}

export function ReportingPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const canManage = useCanManagePublications(projectId)
  const [exportToDelete, setExportToDelete] = useState<ExportArtifact | null>(null)
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
  const { setPendingJobId, pendingJob } = usePendingJob(projectId, {
    clearOnComplete: false,
    onComplete: () => queryClient.invalidateQueries({ queryKey: ['exports', projectId] }),
  })

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

  const deleteExport = useMutation({
    mutationFn: (artifactId: string) => apiRequest<void>(
      `/api/v1/projects/${projectId}/exports/${artifactId}`,
      { method: 'DELETE' },
    ),
    onSuccess: () => {
      setExportToDelete(null)
      queryClient.invalidateQueries({ queryKey: ['exports', projectId] })
    },
  })

  const queryError = prisma.error ?? exportsQuery.error ?? deleteExport.error
  const prismaCounts = Object.entries(prisma.data ?? {}).filter(
    ([, value]) => typeof value === 'number',
  ) as Array<[string, number]>
  const artifacts = exportsQuery.data ?? []

  return (
    <main className="page">
      <StageEyebrow stage="completed" />
      <h1>Reporting and Exports</h1>
      <p className="muted">
        Generate PRISMA diagrams, data exports, and citation files for this review.
      </p>
      {queryError ? <p className="error" role="alert">{queryError.message}</p> : null}
      {createExport.error ? <p className="error" role="alert">{createExport.error.message}</p> : null}
      {pendingJob && isJobActive(pendingJob.status) ? (
        <p className="reporting-job-notice" role="status">Generating export…</p>
      ) : null}
      {pendingJob && pendingJob.status === 'failed' ? (
        <p className="error" role="alert">
          Export failed{pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
        </p>
      ) : null}

      <div className="reporting-overview-grid">
        <figure className="reporting-prisma-card">
          <figcaption>
            <div>
              <span className="eyebrow">Study selection</span>
              <h2>PRISMA Flow</h2>
            </div>
          </figcaption>
          <div className="reporting-prisma-card__canvas">
            <img
              src={`/api/v1/projects/${projectId}/prisma/svg`}
              alt="PRISMA flow diagram showing record counts through identification, screening, and inclusion"
            />
          </div>
        </figure>

        <section className="reporting-counts-card" aria-labelledby="prisma-counts-heading">
          <div>
            <span className="eyebrow">At a glance</span>
            <h2 id="prisma-counts-heading">PRISMA Counts</h2>
          </div>
          {prisma.isLoading ? <p>Loading counts…</p> : null}
          {prismaCounts.length ? (
            <dl className="reporting-counts">
              {prismaCounts.slice(0, 8).map(([key, value]) => (
                <div key={key}>
                  <dt>{humanizeKey(key)}</dt>
                  <dd>{value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          ) : !prisma.isLoading ? <p className="muted">No count data is available yet.</p> : null}
          <details className="reporting-raw-counts">
            <summary>View raw reporting data</summary>
            <pre>{JSON.stringify(prisma.data, null, 2)}</pre>
          </details>
        </section>
      </div>

      <section className="reporting-export-section" aria-labelledby="create-export-heading">
        <header>
          <div>
            <span className="eyebrow">Choose a format</span>
            <h2 id="create-export-heading">Create a New Export</h2>
          </div>
        </header>
        <div className="reporting-export-grid">
          {exportOptions.map((option) => (
            <article className="reporting-export-option" key={option.type}>
              <div className="reporting-export-option__heading">
                <span className="reporting-export-option__icon" aria-hidden="true">
                  <IconDownload />
                </span>
                <h3>{option.title}</h3>
              </div>
              <p>{option.description}</p>
              <button
                type="button"
                onClick={() => createExport.mutate(option.type)}
                disabled={createExport.isPending}
              >
                <IconDownload />
                {option.buttonLabel}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="reporting-library" aria-labelledby="available-exports-heading">
        <header>
          <div>
            <span className="eyebrow">Download library</span>
            <h2 id="available-exports-heading">Available Exports</h2>
          </div>
          <CountPill count={artifacts.length}>ready</CountPill>
        </header>
        {exportsQuery.isLoading ? <p>Loading exports…</p> : null}
        {!exportsQuery.isLoading && artifacts.length === 0 ? (
          <div className="empty-state reporting-library__empty">
            <span className="reporting-card-icon" aria-hidden="true"><IconDownload /></span>
            <h3>Your generated files will appear here</h3>
            <p>Choose an export format above to create the first one.</p>
          </div>
        ) : (
          <ul className="reporting-export-list">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <span className="reporting-export-list__icon" aria-hidden="true"><IconDownload /></span>
                <div className="reporting-export-list__details">
                  <a href={`/api/v1/projects/${projectId}/exports/${artifact.id}/download`}>
                    {artifact.filename}
                  </a>
                  <span>
                    {formatArtifactType(artifact.type)} ·{' '}
                    {new Date(artifact.createdAt).toLocaleString()}
                  </span>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    className="button-danger"
                    disabled={deleteExport.isPending}
                    onClick={() => setExportToDelete(artifact)}
                  >
                    <IconTrash />
                    Delete
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {exportToDelete ? (
        <ConfirmDialog
          title="Delete export?"
          message={<>Delete <strong>{exportToDelete.filename}</strong>? This cannot be undone.</>}
          confirmLabel="Delete Export"
          variant="danger"
          onConfirm={() => deleteExport.mutate(exportToDelete.id)}
          onCancel={() => setExportToDelete(null)}
        />
      ) : null}
    </main>
  )
}
