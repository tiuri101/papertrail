import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { DateField } from '../../components/DateField'
import { getCsrfToken } from '../auth/session'
import { BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'
import { AttachPdfsPanel } from './AttachPdfsPanel'
import { FileDropZone } from './FileDropZone'
import { PdfMatchReview, type PdfSummary } from './PdfMatchReview'

interface SearchImportBatch {
  id: string
  originalFilename: string
  status: string
  recordCount: number
  completedAt: string | null
}

interface SearchSource {
  id: string
  sourceName: string
  query: string
  searchDate: string
  filters: string | null
  importBatches?: SearchImportBatch[]
}

interface ImportResult { jobId: string; importBatchId: string }

export function ImportPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [pdfFiles, setPdfFiles] = useState<File[]>([])
  const [pdfArchives, setPdfArchives] = useState<File[]>([])
  const [sourceName, setSourceName] = useState('')
  const [query, setQuery] = useState('')
  const [searchDate, setSearchDate] = useState('')
  const [filters, setFilters] = useState('')
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const [pendingBatchId, setPendingBatchId] = useState<string | null>(null)
  const [showPdfReview, setShowPdfReview] = useState(false)
  const [attachBatchId, setAttachBatchId] = useState<string | null>(null)

  const searches = useQuery({
    queryKey: ['searches', projectId],
    queryFn: () => apiRequest<SearchSource[]>(`/api/v1/projects/${projectId}/searches`),
    enabled: Boolean(projectId),
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
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    }
  }, [pendingJob, projectId, queryClient])

  const submit = useMutation({
    mutationFn: async (): Promise<ImportResult> => {
      if (!file) throw new Error('Choose a file')

      const search = await apiRequest<SearchSource>(`/api/v1/projects/${projectId}/searches`, {
        method: 'POST',
        body: JSON.stringify({
          sourceName,
          query,
          searchDate,
          filters: filters.trim() || null,
        }),
      })

      const form = new FormData()
      form.append('file', file)
      form.append('searchSourceId', search.id)
      pdfFiles.forEach((pdf) => form.append('pdfs', pdf))
      pdfArchives.forEach((archive) => form.append('pdfArchive', archive))
      const response = await fetch(`/api/v1/projects/${projectId}/imports`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() ?? '' },
        body: form,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.error?.message ?? 'Import failed')
      }
      return response.json() as Promise<ImportResult>
    },
    onSuccess: (result) => {
      setSourceName('')
      setQuery('')
      setSearchDate('')
      setFilters('')
      setFile(null)
      setPdfFiles([])
      setPdfArchives([])
      setPendingJobId(result.jobId)
      setPendingBatchId(result.importBatchId)
      queryClient.invalidateQueries({ queryKey: ['searches', projectId] })
    },
  })

  return (
    <main className="page">
      <h1>Import Records</h1>

      <section className="card">
        <h2>Import an Export File</h2>
        <p className="muted">Record the database and search string used alongside the file, so it can be traced back for this import and reported in your PRISMA flow.</p>
        {submit.error ? <p className="error" role="alert">{submit.error.message}</p> : null}
        <form onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
          <label>
            Database
            <input value={sourceName} onChange={(event) => setSourceName(event.target.value)} required />
          </label>
          <label>
            Search string
            <textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} required />
          </label>
          <DateField label="Search date" value={searchDate} onChange={setSearchDate} required />
          <label>
            Filters applied (optional)
            <input value={filters} onChange={(event) => setFilters(event.target.value)} />
          </label>
          <FileDropZone
            id="bibliographic-export"
            label="Bibliographic export"
            hint="CSV, TSV, XLSX, RIS, or BibTeX"
            accept=".csv,.tsv,.xlsx,.ris,.bib,.bibtex"
            files={file ? [file] : []}
            onChange={(files) => setFile(files[0] ?? null)}
          />
          <FileDropZone
            id="fulltext-pdfs"
            label="Optional full-text PDFs"
            hint="PDF files"
            accept="application/pdf,.pdf"
            multiple
            files={pdfFiles}
            onChange={setPdfFiles}
          />
          <FileDropZone
            id="pdf-archives"
            label="Optional PDF ZIPs"
            hint="ZIP archives of PDF files"
            accept="application/zip,.zip"
            multiple
            files={pdfArchives}
            onChange={setPdfArchives}
          />
          <button type="submit" disabled={!file || submit.isPending}>Upload</button>
          {submit.isPending ? (
            <p role="status">
              Uploading metadata
              {pdfFiles.length ? `, ${pdfFiles.length} PDFs` : ''}
              {pdfArchives.length ? `, ${pdfArchives.length} ZIP archives` : ''}…
            </p>
          ) : null}
        </form>
        {submit.data ? (
          !pendingJob || isJobActive(pendingJob.status) ? (
            <p>Import queued: {submit.data.jobId}</p>
          ) : pendingJob.status === 'completed' ? (
            <>
              <p>Import complete.</p>
              {(() => {
                const pdfSummary = pendingJob.result?.pdfs as PdfSummary | undefined
                if (!pdfSummary?.total) return null
                const needsReview = (pdfSummary.ambiguous ?? 0)
                  + (pdfSummary.unmatched ?? 0)
                  + (pdfSummary.conflict_existing_pdf ?? 0)
                return (
                  <div className="import-summary">
                    <h3>PDF import</h3>
                    <p>{pdfSummary.total} files processed · {pdfSummary.matched ?? 0} matched · {needsReview} need review · {pdfSummary.duplicate ?? 0} duplicate · {pdfSummary.invalid ?? 0} invalid</p>
                    {needsReview ? (
                      <button type="button" onClick={() => setShowPdfReview(true)}>
                        Review PDF matches
                      </button>
                    ) : null}
                  </div>
                )
              })()}
            </>
          ) : (
            <p className="error" role="alert">
              Import {pendingJob.status}
              {pendingJob.errorMessage ? `: ${pendingJob.errorMessage}` : ''}
            </p>
          )
        ) : null}
        {searches.data?.length ? (
          <>
            <h3>Previously Documented Searches</h3>
            <ul>
              {searches.data.map((search) => (
                <li key={search.id}>
                  <strong>{search.sourceName}</strong>: {search.query} — {search.searchDate}
                  {(search.importBatches ?? [])
                    .filter((batch) => batch.status === 'completed')
                    .map((batch) => (
                      <div className="toolbar" key={batch.id}>
                        <span className="muted">
                          {batch.originalFilename} · {batch.recordCount} records
                        </span>
                        <button
                          type="button"
                          onClick={() => setAttachBatchId(
                            attachBatchId === batch.id ? null : batch.id,
                          )}
                        >
                          {attachBatchId === batch.id ? 'Cancel' : 'Attach PDFs'}
                        </button>
                      </div>
                    ))}
                  {attachBatchId
                  && search.importBatches?.some((batch) => batch.id === attachBatchId) ? (
                    <AttachPdfsPanel
                      projectId={projectId}
                      importBatchId={attachBatchId}
                      onClose={() => setAttachBatchId(null)}
                    />
                    ) : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      {showPdfReview && pendingBatchId ? (
        <PdfMatchReview projectId={projectId} importBatchId={pendingBatchId} />
      ) : null}
    </main>
  )
}
