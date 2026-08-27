import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CountPill } from '../../components/CountPill'
import { DateField } from '../../components/DateField'
import { IconClock, IconPerson, IconTrash, IconUpload } from '../../components/icons'
import { Input } from '../../components/Input'
import { Page } from '../../components/Page'
import { useRegisterSectionItems } from '../../components/sectionNavigation'
import { Textarea } from '../../components/Textarea'
import { InfoTooltip } from '../../components/Tooltip'
import { getCsrfToken } from '../auth/session'
import { isJobActive } from '../jobs/jobStatus'
import { usePendingJobs } from '../jobs/usePendingJob'
import { StageEyebrow } from '../projects/StageEyebrow'
import { AttachPdfsPanel } from './AttachPdfsPanel'
import { FileDropZone } from './FileDropZone'
import { PdfMatchReview, type PdfSummary } from './PdfMatchReview'
import { FieldLabel } from '../../components/FieldLabel'
import { Form } from '../../components/Form'

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
type ImportResults = ImportResult[]

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
  const [files, setFiles] = useState<File[]>([])
  const [pdfFiles, setPdfFiles] = useState<File[]>([])
  const [pdfArchives, setPdfArchives] = useState<File[]>([])
  const [sourceName, setSourceName] = useState('')
  const [query, setQuery] = useState('')
  const [searchDate, setSearchDate] = useState('')
  const [filters, setFilters] = useState('')
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

  const { setPendingJobIds, pendingJobs } = usePendingJobs(projectId, {
    clearOnComplete: false,
    onComplete: () => {
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
      queryClient.invalidateQueries({ queryKey: pdfMatchesQueryKey })
      queryClient.invalidateQueries({ queryKey: ['searches', projectId] })
    },
  })

  useEffect(() => {
    if (!searches.isLoading && hadSearchHistoryOnLoad === null) {
      setHadSearchHistoryOnLoad(Boolean(searches.data?.length))
    }
  }, [hadSearchHistoryOnLoad, searches.data, searches.isLoading])

  useEffect(() => {
    // PDFs/PDF ZIPs uploaded alongside the metadata files are only ever staged
    // against the first import batch, so that job's result is the only one
    // that can carry a `pdfs` summary worth auto-scrolling to.
    const pdfJob = pendingJobs[0]
    if (
      pdfJob?.status !== 'completed'
      || !projectNeedsPdfReview
      || autoScrolledPdfReviewJobIdRef.current === pdfJob.id
    ) return
    const pdfSummary = pdfJob.result?.pdfs as PdfSummary | undefined
    const needsReview = (pdfSummary?.ambiguous ?? 0)
      + (pdfSummary?.unmatched ?? 0)
      + (pdfSummary?.conflict_existing_pdf ?? 0)
    if (needsReview === 0) return
    const reviewCard = document.getElementById('section-pdf-review')
    if (!reviewCard) return
    autoScrolledPdfReviewJobIdRef.current = pdfJob.id
    reviewCard.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [pendingJobs, projectNeedsPdfReview])

  const submit = useMutation({
    mutationFn: async (): Promise<ImportResults> => {
      if (!files.length) throw new Error('Choose at least one file')

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
      files.forEach((bibliographicFile) => form.append('file', bibliographicFile))
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
      return response.json() as Promise<ImportResults>
    },
    onSuccess: (results) => {
      setSourceName('')
      setQuery('')
      setSearchDate('')
      setFilters('')
      setFiles([])
      setPdfFiles([])
      setPdfArchives([])
      setPendingJobIds(results.map((result) => result.jobId))
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

  const importResults = submit.data ?? []

  return (
    <Page>
      <StageEyebrow stage="draft" />
      <h1>Searches and Imports</h1>
      <p className="text-text">
        Import publication records from a database export, or review the searches already
        documented for this project.
      </p>

      {hadSearchHistoryOnLoad === null ? (
        <Card as="section" id="section-import-records">
          <h2>Import a Database Export</h2>
          <p className="text-text">Loading documented searches…</p>
        </Card>
      ) : (
        <CollapsibleSection
          id="section-import-records"
          title="Import a Database Export"
          defaultExpanded={!hadSearchHistoryOnLoad}
        >
        <p className="text-text">Record the database and search string used alongside the file, so it can be traced back for this import and reported in your PRISMA flow.</p>
        {submit.error ? <p className="text-danger" role="alert">{submit.error.message}</p> : null}
        <Form onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
          <FieldLabel>
            Database
            <Input value={sourceName} onChange={(event) => setSourceName(event.target.value)} required />
          </FieldLabel>
          <FieldLabel>
            Search string
            <Textarea value={query} onChange={(event) => setQuery(event.target.value)} rows={2} required />
          </FieldLabel>
          <DateField label="Search date" value={searchDate} onChange={setSearchDate} required />
          <FieldLabel>
            Filters applied (optional)
            <Input value={filters} onChange={(event) => setFilters(event.target.value)} />
          </FieldLabel>
          <FileDropZone
            id="bibliographic-export"
            label="Bibliographic export"
            hint="CSV, TSV, XLSX, RIS, or BibTeX — one or more files, each becomes its own import"
            accept=".csv,.tsv,.xlsx,.ris,.bib,.bibtex"
            multiple
            files={files}
            onChange={setFiles}
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
          <Button type="submit" disabled={!files.length || submit.isPending}>
            <IconUpload />
            Upload
          </Button>
          {submit.isPending ? (
            <p role="status">
              Uploading {files.length} bibliographic file{files.length === 1 ? '' : 's'}
              {pdfFiles.length ? `, ${pdfFiles.length} PDFs` : ''}
              {pdfArchives.length ? `, ${pdfArchives.length} ZIP archives` : ''}…
            </p>
          ) : null}
        </Form>
        {importResults.length > 0 ? (
          <div className="grid gap-3">
            {importResults.map((result, index) => {
              const job = pendingJobs.find((candidate) => candidate.id === result.jobId)
              const filePosition = importResults.length > 1 ? ` (file ${index + 1} of ${importResults.length})` : ''
              if (!job || isJobActive(job.status)) {
                return <p key={result.jobId}>Import queued{filePosition}: {result.jobId}</p>
              }
              if (job.status === 'completed') {
                const pdfSummary = job.result?.pdfs as PdfSummary | undefined
                const needsReview = pdfSummary
                  ? (pdfSummary.ambiguous ?? 0) + (pdfSummary.unmatched ?? 0) + (pdfSummary.conflict_existing_pdf ?? 0)
                  : 0
                return (
                  <div key={result.jobId}>
                    <p>Import complete{filePosition}.</p>
                    {pdfSummary?.total ? (
                      <div className="grid gap-3 rounded-md border border-border bg-bg-elevated p-4">
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
                    ) : null}
                  </div>
                )
              }
              return (
                <p className="text-danger" role="alert" key={result.jobId}>
                  Import {job.status}{filePosition}
                  {job.errorMessage ? `: ${job.errorMessage}` : ''}
                </p>
              )
            })}
          </div>
        ) : null}
        </CollapsibleSection>
      )}

      <Card
        as="section"
        className="mt-6"
        id="section-search-history"
        aria-labelledby="search-history-title"
      >
        <h2 id="search-history-title">Previously Documented Searches</h2>
        {searches.data?.length ? (
          <CountPill count={searches.data.length}>
            documented search{searches.data.length === 1 ? '' : 'es'}
          </CountPill>
        ) : (
          <p className="text-text">No searches have been documented for this project yet.</p>
        )}

        {searches.data?.length ? (
          <ol className="m-0 grid list-none gap-4 p-0">
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
                  <li className="overflow-hidden rounded-md border border-border bg-surface-raised shadow-sm" key={search.id}>
                    <header className="flex items-center justify-between gap-4 p-4 min-[561px]:p-5 max-[560px]:flex-wrap max-[560px]:items-start">
                      <div className="flex min-w-0 items-center gap-3 max-[560px]:basis-full">
                        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-primary-container text-[1.1rem] font-bold text-primary" aria-hidden="true">
                          {search.sourceName.slice(0, 1).toUpperCase()}
                        </span>
                        <div>
                          <span className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-primary">Database</span>
                          <h4 className="m-0 text-[1.08rem] font-semibold">{search.sourceName}</h4>
                        </div>
                      </div>
                      <div className="grid min-w-[82px] shrink-0 rounded-md border border-[color-mix(in_srgb,var(--color-primary)_24%,var(--color-border))] bg-primary-container px-4 py-2 text-center text-primary" aria-label={`${paperCount} papers`}>
                        <strong className="text-[1.35rem] leading-[1.1]">{paperCount}</strong>
                        <span className="text-xs font-bold uppercase">{paperCount === 1 ? 'paper' : 'papers'}</span>
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
                      <p className="text-danger" role="alert">{previewDeleteSearch.error.message}</p>
                    ) : null}

                    <dl className="m-0 grid grid-cols-1 border-y border-border bg-[color-mix(in_srgb,var(--color-surface-hover)_50%,transparent)] min-[561px]:grid-cols-2 min-[821px]:grid-cols-4 [&>div]:min-w-0 [&>div]:border-t [&>div]:border-border [&>div]:px-4 [&>div]:py-3 [&>div:first-child]:border-t-0 min-[561px]:[&>div:nth-child(-n+2)]:border-t-0 min-[561px]:[&>div:nth-child(even)]:border-l min-[821px]:[&>div]:border-l min-[821px]:[&>div]:border-t-0 min-[821px]:[&>div:first-child]:border-l-0 [&_dd]:mt-1 [&_dd]:wrap-anywhere [&_dd]:text-[0.86rem] [&_dd]:text-text-secondary [&_dt]:flex [&_dt]:items-center [&_dt]:gap-1 [&_dt]:text-xs [&_dt]:font-bold [&_dt]:uppercase [&_dt]:tracking-[0.05em] [&_dt]:text-text-muted [&_dt_svg]:size-3.5 [&_dt_svg]:fill-current">
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

                    <div className="grid grid-cols-1 gap-3 p-4 min-[561px]:p-5 min-[821px]:grid-cols-[minmax(0,2fr)_minmax(220px,1fr)]">
                      <div className="min-w-0 rounded-sm border border-border bg-bg-elevated px-4 py-3">
                        <span className="mb-1 block text-xs font-bold uppercase tracking-[0.05em] text-primary">Search string</span>
                        <p className="whitespace-pre-wrap text-sm text-text-secondary">{search.query}</p>
                      </div>
                      <div className="min-w-0 rounded-sm border border-border bg-bg-elevated px-4 py-3">
                        <span className="mb-1 block text-xs font-bold uppercase tracking-[0.05em] text-primary">Filters applied</span>
                        <p className="whitespace-pre-wrap text-sm text-text-secondary">{search.filters?.trim() || 'No filters documented'}</p>
                      </div>
                    </div>

                    {batches.length ? (
                      <div className="mx-4 mb-4 border-t border-border pt-4 min-[561px]:mx-5 min-[561px]:mb-5">
                        <h5 className="mb-3 text-[0.82rem] font-semibold uppercase tracking-[0.04em] text-text">Import files</h5>
                        <ul className="m-0 grid list-none gap-2 p-0">
                          {batches.map((batch) => (
                            <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-sm border border-border bg-surface p-3 min-[561px]:grid-cols-[minmax(0,1fr)_auto_auto]" key={batch.id}>
                              <div className="grid min-w-0">
                                <strong className="truncate text-sm">{batch.originalFilename}</strong>
                                <span className="text-[0.8rem] text-text">
                                  {batch.recordCount} records · {batch.attachedPaperCount ?? 0} paper{batch.attachedPaperCount === 1 ? '' : 's'} with PDF
                                  {batch.completedAt
                                    ? ` · completed ${formatDocumentedAt(batch.completedAt)}`
                                    : ''}
                                </span>
                              </div>
                              <Badge variant={batch.status === 'completed' ? 'success' : batch.status === 'failed' ? 'danger' : 'warning'}>
                                {formatImportStatus(batch.status)}
                              </Badge>
                              {batch.status === 'completed' ? (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="sm"
                                  className="max-[560px]:col-span-full max-[560px]:w-full"
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
                      <p className="mx-4 mb-4 rounded-sm border border-dashed border-border px-4 py-3 text-[0.86rem] text-text-muted min-[561px]:mx-5 min-[561px]:mb-5">No import file is associated with this search yet.</p>
                    )}

                    {attachBatchId
                    && batches.some((batch) => batch.id === attachBatchId) ? (
                      <div className="mx-4 mb-4 min-[561px]:mx-5 min-[561px]:mb-5">
                        <AttachPdfsPanel
                          projectId={projectId}
                          importBatchId={attachBatchId}
                          onClose={() => setAttachBatchId(null)}
                        />
                      </div>
                      ) : null}
                  </li>
                )
              })}
          </ol>
        ) : (
          <p className="py-4 text-center text-text-secondary">Your documented search strategies and import summaries will appear here.</p>
        )}
      </Card>
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
                <span className="mt-3 block text-danger" role="alert">
                  {deleteCandidate.preview.screenedPublicationCount === 1
                    ? 'One of these papers has'
                    : `${deleteCandidate.preview.screenedPublicationCount} of these papers have`}{' '}
                  already been screened. Deleting will permanently lose that screening
                  {deleteCandidate.preview.screenedPublicationCount === 1 ? ' decision.' : ' work.'}
                </span>
              ) : null}
              {confirmDeleteSearch.error ? (
                <span className="mt-3 block text-danger" role="alert">
                  {confirmDeleteSearch.error.message}
                </span>
              ) : null}
            </>
          )}
        />
      ) : null}
    </Page>
  )
}
