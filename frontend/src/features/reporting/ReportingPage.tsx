import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CountPill } from '../../components/CountPill'
import { IconDownload, IconTrash } from '../../components/icons'
import { Page } from '../../components/Page'
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

const reportingIconClass = 'inline-grid size-11 shrink-0 place-items-center rounded-md bg-primary-container text-primary [&_svg]:size-[1.3rem] [&_svg]:fill-current'

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
    <Page>
      <StageEyebrow stage="completed" />
      <h1>Reporting and Exports</h1>
      <p className="text-text-muted">
        Generate PRISMA diagrams, data exports, and citation files for this review.
      </p>
      {queryError ? <p className="text-danger" role="alert">{queryError.message}</p> : null}
      {createExport.error ? <p className="text-danger" role="alert">{createExport.error.message}</p> : null}
      {pendingJob && isJobActive(pendingJob.status) ? (
        <p className="rounded-md border border-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] bg-primary-container px-4 py-3 font-bold text-primary" role="status">Generating export…</p>
      ) : null}
      {pendingJob && pendingJob.status === 'failed' ? (
        <p className="text-danger" role="alert">
          Export failed{pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
        </p>
      ) : null}

      <div className="mb-6 grid grid-cols-1 gap-5 min-[1051px]:grid-cols-[minmax(0,1.55fr)_minmax(18rem,0.75fr)]">
        <Card as="figure" className="m-0 bg-none bg-surface">
          <figcaption className="flex items-start justify-start gap-4">
            <div>
              <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.08em] text-primary">Study selection</span>
              <h2>PRISMA Flow</h2>
            </div>
          </figcaption>
          <div className="overflow-hidden rounded-md border border-border bg-white p-4">
            <img
              className="block h-auto w-full"
              src={`/api/v1/projects/${projectId}/prisma/svg`}
              alt="PRISMA flow diagram showing record counts through identification, screening, and inclusion"
            />
          </div>
        </Card>

        <Card as="section" className="m-0 flex flex-col bg-none bg-surface" aria-labelledby="prisma-counts-heading">
          <div>
            <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.08em] text-primary">At a glance</span>
            <h2 id="prisma-counts-heading">PRISMA Counts</h2>
          </div>
          {prisma.isLoading ? <p>Loading counts…</p> : null}
          {prismaCounts.length ? (
            <dl className="my-5 grid gap-2">
              {prismaCounts.slice(0, 8).map(([key, value]) => (
                <div className="flex items-center justify-between gap-3 border-b border-border py-2" key={key}>
                  <dt className="text-[0.86rem] text-text-secondary">{humanizeKey(key)}</dt>
                  <dd className="m-0 text-[1.15rem] font-bold text-text">{value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          ) : !prisma.isLoading ? <p className="text-text-muted">No count data is available yet.</p> : null}
          <details className="mt-auto border-t border-border pt-3">
            <summary className="cursor-pointer font-bold text-primary">View raw reporting data</summary>
            <pre className="max-h-80 overflow-auto text-[0.78rem]">{JSON.stringify(prisma.data, null, 2)}</pre>
          </details>
        </Card>
      </div>

      <Card as="section" className="mb-6 bg-none bg-surface" aria-labelledby="create-export-heading">
        <header className="flex flex-col items-stretch justify-between gap-4 min-[681px]:flex-row min-[681px]:items-start">
          <div>
            <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.08em] text-primary">Choose a format</span>
            <h2 id="create-export-heading">Create a New Export</h2>
          </div>
        </header>
        <div className="grid grid-cols-1 gap-4 min-[681px]:grid-cols-2 min-[1051px]:grid-cols-4">
          {exportOptions.map((option) => (
            <article className="flex min-w-0 flex-col items-start rounded-md border border-border bg-surface-raised p-5 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-border-strong" key={option.type}>
              <div className="mb-4 flex w-full min-w-0 items-center gap-3">
                <span className={reportingIconClass} aria-hidden="true">
                  <IconDownload />
                </span>
                <h3 className="m-0 min-w-0 leading-tight [overflow-wrap:anywhere]">{option.title}</h3>
              </div>
              <p className="mb-4 mt-0 flex-1 text-sm leading-normal text-text-secondary">{option.description}</p>
              <Button
                type="button"
                className="h-auto min-h-10 w-full min-w-0 whitespace-normal text-center leading-tight"
                startIcon={<IconDownload />}
                onClick={() => createExport.mutate(option.type)}
                disabled={createExport.isPending}
              >
                {option.buttonLabel}
              </Button>
            </article>
          ))}
        </div>
      </Card>

      <Card as="section" className="mb-6 bg-none bg-surface" aria-labelledby="available-exports-heading">
        <header className="flex items-center justify-between gap-4">
          <div>
            <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.08em] text-primary">Download library</span>
            <h2 id="available-exports-heading">Available Exports</h2>
          </div>
          <CountPill count={artifacts.length} className="mb-0">ready</CountPill>
        </header>
        {exportsQuery.isLoading ? <p>Loading exports…</p> : null}
        {!exportsQuery.isLoading && artifacts.length === 0 ? (
          <div className="grid justify-items-center rounded-md border border-dashed border-border-strong p-8 text-center">
            <span className={reportingIconClass} aria-hidden="true"><IconDownload /></span>
            <h3 className="mb-2 mt-4">Your generated files will appear here</h3>
            <p className="m-0 text-text-secondary">Choose an export format above to create the first one.</p>
          </div>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {artifacts.map((artifact) => (
              <li className="flex flex-wrap items-start gap-4 rounded-md border border-border bg-surface-raised px-4 py-3 min-[681px]:flex-nowrap min-[681px]:items-center" key={artifact.id}>
                <span className={reportingIconClass} aria-hidden="true"><IconDownload /></span>
                <div className="grid min-w-0 flex-1 basis-[calc(100%-4rem)] gap-1 min-[681px]:basis-auto">
                  <a className="overflow-hidden font-bold text-ellipsis whitespace-nowrap" href={`/api/v1/projects/${projectId}/exports/${artifact.id}/download`}>
                    {artifact.filename}
                  </a>
                  <span className="text-[0.82rem] text-text-muted">
                    {formatArtifactType(artifact.type)} ·{' '}
                    {new Date(artifact.createdAt).toLocaleString()}
                  </span>
                </div>
                {canManage ? (
                  <Button
                    type="button"
                    variant="destructive"
                    startIcon={<IconTrash />}
                    disabled={deleteExport.isPending}
                    onClick={() => setExportToDelete(artifact)}
                  >
                    Delete
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
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
    </Page>
  )
}
