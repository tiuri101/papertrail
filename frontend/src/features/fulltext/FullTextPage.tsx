import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CountPill } from '../../components/CountPill'
import { DoiPill } from '../../components/DoiPill'
import { GoBackButton } from '../../components/GoBackButton'
import { InfoBox } from '../../components/InfoBox'
import { IconAlertTriangle, IconArrowRight } from '../../components/icons'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { StageEyebrow } from '../projects/StageEyebrow'
import { PreviousItemCard } from '../screening/PreviousItemCard'
import { ScreeningItemCard } from '../screening/ScreeningItemCard'
import { useScreeningQueue } from '../screening/useScreeningQueue'
import { useBrowserPdfRetrieval } from './useBrowserPdfRetrieval'
import { fullTextDocumentEndpoint, useFullTextDocument } from './useFullTextDocument'
import type { Retrieval } from './useRetrievalQueue'
import { useRetrievalQueue } from './useRetrievalQueue'
import { FullTextDocumentPanel } from './FullTextDocumentPanel'
import { Select } from '../../components/Select'
import { Textarea } from '../../components/Textarea'
import { Button } from '../../components/Button'
import { Page } from '../../components/Page'
import { FieldLabel } from '../../components/FieldLabel'

const statusLabels: Record<string, string> = {
  not_yet_sought: 'Not yet sought',
  requested: 'Requested',
  not_found: 'Not found',
  inaccessible: 'Inaccessible',
  available: 'Available',
}

function formatStatus(status: string) {
  return statusLabels[status] ?? status
}

const retrievalStatusOptions = Object.keys(statusLabels)

export function FullTextPage() {
  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const highlightKeywords = useHighlightKeywords(projectId)
  const queue = useScreeningQueue(projectId, 'full_text')
  const retrievalQueue = useRetrievalQueue(projectId)
  const browserRetrieval = useBrowserPdfRetrieval(projectId)

  // A publication currently shown as a manual retrieval card can become
  // available via the browser extension while the reviewer has it open --
  // drop the now-stale card rather than risk submitting an outdated status.
  const openPublicationId = retrievalQueue.item?.publication.id
  const succeededElsewhere = browserRetrieval.latestBatch?.succeededPublicationIds
  useEffect(() => {
    if (openPublicationId && succeededElsewhere?.includes(openPublicationId)) {
      retrievalQueue.advance()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPublicationId, succeededElsewhere])

  const updateRetrieval = useMutation({
    mutationFn: ({ id, status, note }: {
      id: string
      status: string
      note: string | null
    }) =>
      apiRequest<{ decisionSubmitted: boolean }>(`/api/v1/projects/${projectId}/full-text/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status, note, decision: null }),
      }),
  })

  const handleSubmit = async (
    retrieval: Retrieval,
    status: string,
    note: string | null,
  ) => {
    await updateRetrieval.mutateAsync({ id: retrieval.id, status, note })
    if (status === 'available') queue.fetchNext()
    retrievalQueue.advance()
  }

  const progress = retrievalQueue.progress
  const isLoading = retrievalQueue.loadingNext || queue.loadingNext || progress === undefined

  const visibleItemId = queue.previousItem?.id ?? queue.item?.id ?? retrievalQueue.item?.id
  useEffect(() => {
    if (visibleItemId) window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [visibleItemId])

  return (
    <Page>
      <StageEyebrow stage="full_text_screening" />
      <h1>Full-Text</h1>
      {browserRetrieval.missingCount ? (
        <InfoBox icon={<IconAlertTriangle />} tone="warning" alert>
          <h3>
            {browserRetrieval.missingCount} publication{browserRetrieval.missingCount === 1 ? '' : 's'} missing a PDF
          </h3>
          <p>
            Retrieve missing PDFs automatically with a paired browser helper, or upload them manually,
            from the <Link to={`/projects/${projectId}/publications`}>Publications</Link> page.
          </p>
        </InfoBox>
      ) : null}
      {retrievalQueue.nextError ? <p className="error" role="alert">{retrievalQueue.nextError}</p> : null}
      {updateRetrieval.error ? <p className="error" role="alert">{updateRetrieval.error.message}</p> : null}
      {queue.nextError ? <p className="error" role="alert">{queue.nextError}</p> : null}
      {progress ? (
        <CountPill
          count={progress.addressed}
          className="full-text-retrieval-progress mt-5"
          prefix="Retrieval status recorded for"
        >
          of {progress.total} publications
        </CountPill>
      ) : null}
      {queue.progress ? (
        <CountPill count={queue.progress.remaining}>
          paper{queue.progress.remaining === 1 ? '' : 's'} remaining for screening
        </CountPill>
      ) : null}
      {!queue.previousItem && queue.lastCompletedItem ? (
        <div className="toolbar">
          <GoBackButton onClick={() => queue.goBack.mutate()} disabled={queue.goBack.isPending}>
            ← Go back to “{queue.lastCompletedItem.title}”
          </GoBackButton>
        </div>
      ) : null}
      {queue.goBack.error ? <p className="error" role="alert">{queue.goBack.error.message}</p> : null}
      {queue.previousItem ? (
        <PreviousItemCard
          projectId={projectId}
          stage="full_text"
          previousItem={queue.previousItem}
          highlightKeywords={highlightKeywords}
          onClose={queue.closePrevious}
          save={queue.savePreviousDecision}
        />
      ) : queue.item ? (
        <>
          <FullTextDocumentPanel
            projectId={projectId}
            publicationId={queue.item.publication.id}
            collapsible
          />
          <ScreeningItemCard {...queue} highlightKeywords={highlightKeywords} />
        </>
      ) : isLoading ? (
        <p>Loading…</p>
      ) : progress?.total === 0 ? (
        <p className="muted">No publications require full-text retrieval.</p>
      ) : retrievalQueue.item ? (
        <RetrievalCard
          projectId={projectId}
          retrieval={retrievalQueue.item}
          saving={updateRetrieval.isPending}
          onSubmit={(status, note) => handleSubmit(retrievalQueue.item!, status, note)}
          onSkip={() => retrievalQueue.skip.mutate()}
          skipping={retrievalQueue.skip.isPending}
          skipError={retrievalQueue.skip.error?.message ?? null}
        />
      ) : (
        <>
          <p className="muted">No full-text work is currently available for you.</p>
          <Button type="button" variant="secondary" onClick={() => navigate(`/projects/${projectId}`)}>
            Back to project
          </Button>
        </>
      )}
    </Page>
  )
}

function RetrievalCard({ projectId, retrieval, saving, onSubmit, onSkip, skipping, skipError }: {
  projectId: string
  retrieval: Retrieval
  saving: boolean
  onSubmit: (status: string, note: string | null) => void
  onSkip: () => void
  skipping: boolean
  skipError: string | null
}) {
  const [status, setStatus] = useState(retrieval.status)
  const [note, setNote] = useState(retrieval.note ?? '')
  const publication = retrieval.publication
  const isAvailable = status === 'available'
  const fullTextDocument = useFullTextDocument(projectId, publication.id)

  const handleSubmit = () => {
    onSubmit(status, note || null)
  }

  return (
    <article className="card">
      <h2>{publication.title}</h2>
      <p className="muted">
        {publication.authors ?? 'Unknown authors'}
        {publication.publicationYear ? ` (${publication.publicationYear})` : ''}
      </p>
      <div className="toolbar">
        {fullTextDocument.data ? (
          <PdfAvailabilityPill
            available={fullTextDocument.data.available}
            href={`${fullTextDocumentEndpoint(projectId, publication.id)}/content`}
            pageCount={fullTextDocument.data.document?.pageCount}
          />
        ) : null}
        <DoiPill doi={publication.doi} />
        {isSafeHttpUrl(publication.publisherUrl) ? (
          <PublisherLinkPill url={publication.publisherUrl} />
        ) : null}
      </div>
      {fullTextDocument.data?.available ? (
        <Button
          as="a"
          variant="secondary"
          size="sm"
          href={`${fullTextDocumentEndpoint(projectId, publication.id)}/content`}
          target="_blank"
          rel="noreferrer"
        >
          Open PDF
        </Button>
      ) : null}
      <FullTextDocumentPanel
        projectId={projectId}
        publicationId={publication.id}
        onAvailable={() => setStatus('available')}
        collapsible
      />
      <FieldLabel>
        Retrieval status for {publication.title}
        <Select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {retrievalStatusOptions.map((statusOption) => (
            <option value={statusOption} key={statusOption}>{formatStatus(statusOption)}</option>
          ))}
        </Select>
      </FieldLabel>
      <FieldLabel>
        Note for {publication.title}
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
      </FieldLabel>
      {isAvailable ? (
        <p className="muted">
          Save the available status to open full-text screening and its LLM evidence panel.
        </p>
      ) : null}
      {skipError ? <p className="error" role="alert">{skipError}</p> : null}
      <div className="toolbar">
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={saving || skipping}
        >
          {isAvailable ? 'Save and start screening' : 'Submit'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onSkip}
          disabled={saving || skipping}
        >
          <IconArrowRight />
          Skip for now
        </Button>
      </div>
    </article>
  )
}
