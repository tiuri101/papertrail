import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CountPill } from '../../components/CountPill'
import { DateField } from '../../components/DateField'
import { IconClock, IconPerson, IconTrash, IconUpload } from '../../components/icons'
import { Input } from '../../components/Input'
import { useRegisterSectionItems } from '../../components/sectionNavigation'
import { Textarea } from '../../components/Textarea'
import { InfoTooltip } from '../../components/Tooltip'
import { getCsrfToken } from '../auth/session'
import { BackgroundJob, findJob, hasActiveJob, isJobActive } from '../jobs/jobStatus'
import { StageEyebrow } from '../projects/StageEyebrow'
import { AttachPdfsPanel } from './AttachPdfsPanel'
import { FileDropZone } from './FileDropZone'
import { PdfMatchReview, type PdfSummary } from './PdfMatchReview'

interface SearchImportBatch {
  id: string
  originalFilename: string
  status: string
  recordCount: number
  attachedPaperCount?: number
  completedAt: string | null
}

interface SearchSource {
  id: string
  sourceName: string
  query: string
  searchDate: string
  filters: string | null
  exportedResultCount?: number
  createdAt?: string
  createdBy?: {
    id: string
    displayName: string
    username: string
  }
  importBatches?: SearchImportBatch[]
}

interface ImportResult { jobId: string; importBatchId: string }

interface DeleteSearchPreview {
  deleted: boolean
  requiresConfirmation: boolean
  publicationCount: number
  screenedPublicationCount: number
  screenedPublicationTitles?: string[]
}

const importSections = [
  { id: 'section-import-records', label: 'Import a Database Export' },
  { id: 'section-search-history', label: 'Previously Documented Searches' },
]

function formatSearchDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatDocumentedAt(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatImportStatus(value: string): string {
  return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

export function ImportPage() {
  const { projectId = '' } = useParams()
  useRegisterSectionItems(importSections)
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [pdfFiles, setPdfFiles] = useState<File[]>([])
  const [pdfArchives, setPdfArchives] = useState<File[]>([])
  const [sourceName, setSourceName] = useState('')
  const [query, setQuery] = useState('')
  const [searchDate, setSearchDate] = useState('')
  const [filters, setFilters] = useState('')
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const [attachBatchId, setAttachBatchId] = useState<string | null>(null)
  const [hadSearchHistoryOnLoad, setHadSearchHistoryOnLoad] = useState<boolean | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<
    { search: SearchSource; preview: DeleteSearchPreview } | null
  >(null)
  const autoScrolledPdfReviewJobIdRef = useRef<string | null>(null)

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

  const pdfMatchesQueryKey = ['pdf-matches', projectId, 'project-wide']
  const projectPdfMatches = useQuery({
    queryKey: pdfMatchesQueryKey,
    queryFn: () => apiRequest<{ summary: PdfSummary }>(`/api/v1/projects/${projectId}/pdf-matches`),
    enabled: Boolean(projectId),
  })
  const projectPdfSummary = projectPdfMatches.data?.summary
  const projectNeedsPdfReview = Boolean(
    projectPdfSummary && (
      (projectPdfSummary.ambiguous ?? 0)
      + (projectPdfSummary.unmatched ?? 0)
      + (projectPdfSummary.conflict_existing_pdf ?? 0)
    ) > 0,
  )

  useEffect(() => {
    if (!searches.isLoading && hadSearchHistoryOnLoad === null) {
      setHadSearchHistoryOnLoad(Boolean(searches.data?.length))
    }
  }, [hadSearchHistoryOnLoad, searches.data, searches.isLoading])

  useEffect(() => {
    if (pendingJob && !isJobActive(pendingJob.status)) {
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
      queryClient.invalidateQueries({ queryKey: pdfMatchesQueryKey })
      queryClient.invalidateQueries({ queryKey: ['searches', projectId] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJob, projectId, queryClient])

  useEffect(() => {
    if (
      pendingJob?.status !== 'completed'
      || !projectNeedsPdfReview
      || autoScrolledPdfReviewJobIdRef.current === pendingJob.id
    ) return
    const pdfSummary = pendingJob.result?.pdfs as PdfSummary | undefined
    const needsReview = (pdfSummary?.ambiguous ?? 0)
      + (pdfSummary?.unmatched ?? 0)
      + (pdfSummary?.conflict_existing_pdf ?? 0)
    if (needsReview === 0) return
    const reviewCard = document.getElementById('section-pdf-review')
    if (!reviewCard) return
    autoScrolledPdfReviewJobIdRef.current = pendingJob.id
    reviewCard.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [pendingJob, projectNeedsPdfReview])

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
      queryClient.invalidateQueries({ queryKey: ['searches', projectId] })
    },
  })

  const previewDeleteSearch = useMutation({
    mutationFn: (search: SearchSource) =>
      apiRequest<DeleteSearchPreview>(`/api/v1/projects/${projectId}/searches/${search.id}`, {
        method: 'DELETE',
      }).then((preview) => ({ search, preview })),
    onSuccess: ({ search, preview }) => {
      setDeleteCandidate({ search, preview })
    },
  })

  const confirmDeleteSearch = useMutation({
    mutationFn: (search: SearchSource) =>
      apiRequest<DeleteSearchPreview>(
        `/api/v1/projects/${projectId}/searches/${search.id}?force=true`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      setDeleteCandidate(null)
      queryClient.invalidateQueries({ queryKey: ['searches', projectId] })
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    },
  })

  return (
    <main className="page">
      <StageEyebrow stage="draft" />
      <h1>Searches and Imports</h1>
      <p className="muted">
        Import publication records from a database export, or review the searches already
        documented for this project.
      </p>

      {hadSearchHistoryOnLoad === null ? (
        <section id="section-import-records" className="card">
          <h2>Import a Database Export</h2>
          <p className="muted">Loading documented searches…</p>
        </section>
      ) : (
        <CollapsibleSection
          id="section-import-records"
          title="Import a Database Export"
          defaultExpanded={!hadSearchHistoryOnLoad}
        >
        <p className="muted">Record the database and search string used alongside the file, so it can be traced back for this import and reported in your PRISMA flow.</p>
        {submit.error ? <p className="error" role="alert">{submit.error.message}</p> : null}
        <form onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
          <label>
            Database
            <Input value={sourceName} onChange={(event) => setSourceName(event.target.value)} required />
          </label>
          <label>
            Search string
            <Textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} required />
          </label>
          <DateField label="Search date" value={searchDate} onChange={setSearchDate} required />
          <label>
            Filters applied (optional)
            <Input value={filters} onChange={(event) => setFilters(event.target.value)} />
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
          <Button type="submit" disabled={!file || submit.isPending}>
            <IconUpload />
            Upload
          </Button>
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
                    <h3>
                      PDF import
                      <InfoTooltip text="Matched: automatically linked to a publication by title, DOI, or filename. Need review: the match was uncertain, no match was found, or it conflicts with a PDF already attached — check these manually. Duplicate: this file was already imported. Invalid: the file couldn't be read as a PDF." />
                    </h3>
                    <p>{pdfSummary.total} files processed · {pdfSummary.matched ?? 0} matched · {needsReview} need review · {pdfSummary.duplicate ?? 0} duplicate · {pdfSummary.invalid ?? 0} invalid</p>
                    {needsReview ? (
                      <Button
                        type="button"
                        onClick={() => document
                          .getElementById('section-pdf-review')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      >
                        Review PDF matches
                      </Button>
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
        </CollapsibleSection>
      )}

      <section
        id="section-search-history"
        className="card"
        aria-labelledby="search-history-title"
      >
        <h2 id="search-history-title">Previously Documented Searches</h2>
        {searches.data?.length ? (
          <CountPill count={searches.data.length}>
            documented search{searches.data.length === 1 ? '' : 'es'}
          </CountPill>
        ) : (
          <p className="muted">No searches have been documented for this project yet.</p>
        )}

        {searches.data?.length ? (
          <ol className="search-history__list">
              {searches.data.map((search) => {
                const batches = search.importBatches ?? []
                const importedRecords = batches.reduce(
                  (total, batch) => total + batch.recordCount,
                  0,
                )
                const attachedPapers = batches.reduce(
                  (total, batch) => total + (batch.attachedPaperCount ?? 0),
                  0,
                )
                const paperCount = importedRecords || search.exportedResultCount || 0

                return (
                  <li className="search-history__card" key={search.id}>
                    <header className="search-history__card-header">
                      <div className="search-history__database">
                        <span className="search-history__database-icon" aria-hidden="true">
                          {search.sourceName.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <span className="eyebrow">Database</span>
                          <h4>{search.sourceName}</h4>
                        </div>
                      </div>
                      <div className="search-history__paper-count" aria-label={`${paperCount} papers`}>
                        <strong>{paperCount}</strong>
                        <span>{paperCount === 1 ? 'paper' : 'papers'}</span>
                      </div>
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => previewDeleteSearch.mutate(search)}
                        disabled={previewDeleteSearch.isPending && previewDeleteSearch.variables?.id === search.id}
                      >
                        <IconTrash />
                        Delete search
                      </Button>
                    </header>
                    {previewDeleteSearch.error && previewDeleteSearch.variables?.id === search.id ? (
                      <p className="error" role="alert">{previewDeleteSearch.error.message}</p>
                    ) : null}

                    <dl className="search-history__metadata">
                      <div>
                        <dt><IconClock />Search date</dt>
                        <dd><time dateTime={search.searchDate}>{formatSearchDate(search.searchDate)}</time></dd>
                      </div>
                      <div>
                        <dt><IconPerson />Added by</dt>
                        <dd>
                          {search.createdBy
                            ? `${search.createdBy.displayName} (${search.createdBy.username})`
                            : 'Contributor unavailable'}
                        </dd>
                      </div>
                      <div>
                        <dt><IconUpload />Import overview</dt>
                        <dd>
                          {batches.length} import{batches.length === 1 ? '' : 's'} · {importedRecords} record{importedRecords === 1 ? '' : 's'} · {attachedPapers} imported paper{attachedPapers === 1 ? '' : 's'} with PDF
                        </dd>
                      </div>
                      {search.createdAt ? (
                        <div>
                          <dt>Documented</dt>
                          <dd><time dateTime={search.createdAt}>{formatDocumentedAt(search.createdAt)}</time></dd>
                        </div>
                      ) : null}
                    </dl>

                    <div className="search-history__strategy">
                      <div>
                        <span>Search string</span>
                        <p>{search.query}</p>
                      </div>
                      <div>
                        <span>Filters applied</span>
                        <p>{search.filters?.trim() || 'No filters documented'}</p>
                      </div>
                    </div>

                    {batches.length ? (
                      <div className="search-history__imports">
                        <h5>Import files</h5>
                        <ul>
                          {batches.map((batch) => (
                            <li key={batch.id}>
                              <div className="search-history__import-details">
                                <strong>{batch.originalFilename}</strong>
                                <span className="muted">
                                  {batch.recordCount} records · {batch.attachedPaperCount ?? 0} paper{batch.attachedPaperCount === 1 ? '' : 's'} with PDF
                                  {batch.completedAt
                                    ? ` · completed ${formatDocumentedAt(batch.completedAt)}`
                                    : ''}
                                </span>
                              </div>
                              <span className={`search-history__status search-history__status--${batch.status}`}>
                                {formatImportStatus(batch.status)}
                              </span>
                              {batch.status === 'completed' ? (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  onClick={() => setAttachBatchId(
                                    attachBatchId === batch.id ? null : batch.id,
                                  )}
                                >
                                  {attachBatchId === batch.id ? 'Cancel' : 'Attach PDFs'}
                                </Button>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="search-history__no-imports">No import file is associated with this search yet.</p>
                    )}

                    {attachBatchId
                    && batches.some((batch) => batch.id === attachBatchId) ? (
                      <AttachPdfsPanel
                        projectId={projectId}
                        importBatchId={attachBatchId}
                        onClose={() => setAttachBatchId(null)}
                      />
                      ) : null}
                  </li>
                )
              })}
          </ol>
        ) : (
          <p className="search-history__empty">Your documented search strategies and import summaries will appear here.</p>
        )}
      </section>
      {projectNeedsPdfReview ? (
        <PdfMatchReview projectId={projectId} />
      ) : null}
      {deleteCandidate ? (
        <ConfirmDialog
          title={`Delete search "${deleteCandidate.search.sourceName}"?`}
          variant="danger"
          confirmLabel="Delete Search"
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => confirmDeleteSearch.mutate(deleteCandidate.search)}
          message={(
            <>
              {deleteCandidate.preview.publicationCount > 0 ? (
                <>
                  This will permanently delete the search and{' '}
                  {deleteCandidate.preview.publicationCount === 1
                    ? 'the 1 paper'
                    : `all ${deleteCandidate.preview.publicationCount} papers`}{' '}
                  it exclusively brought in. Papers also found by another search are kept.
                </>
              ) : (
                <>This will permanently delete the search. No papers came in exclusively through it.</>
              )}
              {deleteCandidate.preview.screenedPublicationCount > 0 ? (
                <span className="error" role="alert" style={{ display: 'block', marginTop: '0.75rem' }}>
                  {deleteCandidate.preview.screenedPublicationCount === 1
                    ? 'One of these papers has'
                    : `${deleteCandidate.preview.screenedPublicationCount} of these papers have`}{' '}
                  already been screened. Deleting will permanently lose that screening
                  {deleteCandidate.preview.screenedPublicationCount === 1 ? ' decision.' : ' work.'}
                </span>
              ) : null}
              {confirmDeleteSearch.error ? (
                <span className="error" role="alert" style={{ display: 'block', marginTop: '0.75rem' }}>
                  {confirmDeleteSearch.error.message}
                </span>
              ) : null}
            </>
          )}
        />
      ) : null}
    </main>
  )
}
