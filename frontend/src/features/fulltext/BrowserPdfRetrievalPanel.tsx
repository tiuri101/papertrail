import { Link } from 'react-router-dom'

import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconXCircle } from '../../components/icons'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import type { RetrievalBatch, RetrievalJobSummary } from './useBrowserPdfRetrieval'
import { useBrowserPdfRetrieval } from './useBrowserPdfRetrieval'

function retrievalPublisherUrl(job: RetrievalJobSummary): string | null {
  return isSafeHttpUrl(job.resolvedLandingUrl) ? job.resolvedLandingUrl : null
}

function AttentionJob({ job }: { job: RetrievalJobSummary }) {
  const url = retrievalPublisherUrl(job)
  return (
    <li>
      <strong>{job.title}</strong>
      {' -- '}
      <span className="text-text">{formatStatus(job.status)}</span>
      {job.errorMessage ? <span className="text-text"> ({job.errorMessage})</span> : null}
      {url ? (
        <>
          {' '}
          <a href={url} target="_blank" rel="noreferrer">Open publisher page</a>
        </>
      ) : null}
    </li>
  )
}

const statusLabels: Record<string, string> = {
  needs_authentication: 'Authentication required',
  not_found: 'Not found',
  access_denied: 'Access denied',
  invalid_response: 'Unexpected response',
  failed: 'Failed',
}

function formatStatus(status: string) {
  return statusLabels[status] ?? status
}

function BatchProgressView({ batch, onCancel, cancelling }: {
  batch: RetrievalBatch
  onCancel: () => void
  cancelling: boolean
}) {
  const { progress } = batch
  const inaccessibleOrFailed = progress.accessDenied + progress.invalidResponse + progress.failed
  const remaining = progress.total - progress.processed
  return (
    <>
      <p>{progress.processed} / {progress.total} processed</p>
      <ul className="mb-0 list-disc pl-6">
        <li>{progress.succeeded} retrieved{progress.skippedExisting > 0 ? ` (${progress.skippedExisting} already had a PDF)` : ''}</li>
        <li>{progress.needsAuthentication} authentication required</li>
        <li>{progress.notFound} not found</li>
        <li>{inaccessibleOrFailed} inaccessible/failed</li>
        <li>{remaining} remaining</li>
      </ul>
      {batch.status === 'running' ? (
        <Button type="button" variant="secondary" onClick={onCancel} disabled={cancelling}>
          <IconXCircle />
          Cancel retrieval
        </Button>
      ) : null}
      {batch.attentionJobs.length > 0 ? (
        <details>
          <summary>Publications needing attention ({batch.attentionJobs.length})</summary>
          <ul className="mb-0 list-disc pl-6">
            {batch.attentionJobs.map((job) => <AttentionJob key={job.jobId} job={job} />)}
          </ul>
        </details>
      ) : null}
    </>
  )
}

export function BrowserPdfRetrievalPanel({ projectId }: { projectId: string }) {
  const {
    agents,
    missingCount,
    activeBatch,
    latestBatch,
    createBatch,
    cancelBatch,
    retryFailed,
  } = useBrowserPdfRetrieval(projectId)

  const pairedAgent = agents.data?.[0] ?? null
  const hasRetryableFailures = Boolean(
    latestBatch
    && latestBatch.status !== 'running'
    && latestBatch.attentionJobs.length > 0,
  )

  return (
    <CollapsibleSection id="section-pdf-retrieval" title="PDF retrieval" defaultExpanded={false}>
      {agents.isLoading ? <p className="text-text">Checking for a paired browser helper…</p> : null}
      {agents.data && !pairedAgent ? (
        <p className="text-text">
          No browser helper is paired with your account. Pair the Chrome extension from{' '}
          <Link to="/account">Account Settings</Link> to retrieve publisher PDFs using this
          computer&apos;s institutional access.
        </p>
      ) : null}
      {pairedAgent ? (
        <>
          {missingCount !== null ? (
            <p className="text-text">
              {missingCount} publication{missingCount === 1 ? '' : 's'} {missingCount === 1 ? 'is' : 'are'} missing full text.
            </p>
          ) : null}
          <p className="text-text">Browser helper: ✓ {pairedAgent.displayName}</p>
          {createBatch.error ? <p className="text-danger" role="alert">{createBatch.error.message}</p> : null}
          {cancelBatch.error ? <p className="text-danger" role="alert">{cancelBatch.error.message}</p> : null}
          {retryFailed.error ? <p className="text-danger" role="alert">{retryFailed.error.message}</p> : null}
          {activeBatch ? (
            <BatchProgressView
              batch={activeBatch}
              onCancel={() => cancelBatch.mutate(activeBatch.id)}
              cancelling={cancelBatch.isPending}
            />
          ) : (
            <>
              {latestBatch && latestBatch.progress.total > 0 ? (
                <BatchProgressView
                  batch={latestBatch}
                  onCancel={() => {}}
                  cancelling={false}
                />
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  onClick={() => createBatch.mutate(undefined)}
                  disabled={createBatch.isPending || !missingCount}
                >
                  Retrieve missing PDFs
                </Button>
                {hasRetryableFailures ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => retryFailed.mutate(latestBatch!.id)}
                    disabled={retryFailed.isPending}
                  >
                    Retry failed
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </>
      ) : null}
    </CollapsibleSection>
  )
}
