import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CountPill } from '../../components/CountPill'
import { GoBackButton } from '../../components/GoBackButton'
import { IconArrowRight } from '../../components/icons'
import { Page } from '../../components/Page'
import { StageEyebrow } from '../projects/StageEyebrow'
import { DuplicateComparisonCard } from './DuplicateComparisonCard'
import { DuplicateDecisionButtons } from './DuplicateDecisionButtons'
import { DuplicateDecisionEditor } from './DuplicateDecisionEditor'
import { DuplicateDetectionAction } from './DuplicateDetectionAction'
import { statusLabel } from './types'
import { type DuplicateQueue, useDuplicateQueue } from './useDuplicateQueue'

interface ProjectAccess {
  canManage: boolean
  stage: string
}

const cardClass = 'mt-6 overflow-hidden rounded-lg border border-border bg-surface shadow-sm'

function ActiveDuplicateCard({ queue }: { queue: DuplicateQueue }) {
  const candidate = queue.candidate!
  const pending = queue.merge.isPending || queue.notDuplicate.isPending || queue.skip.isPending
  const error = queue.merge.error ?? queue.notDuplicate.error ?? queue.skip.error

  return (
    <section className={cardClass} aria-label="Duplicate candidate">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-surface-raised/70 px-5 py-4">
        <div>
          <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.08em] text-primary">Candidate pair</span>
          <h2 className="mb-0 mt-0.5 text-base">Compare publication records</h2>
        </div>
      </header>
      <DuplicateComparisonCard candidate={candidate} />
      <DuplicateDecisionButtons
        publicationAId={candidate.publicationA.id}
        publicationBId={candidate.publicationB.id}
        disabled={pending}
        onMerge={(canonicalPublicationId) => queue.merge.mutate(canonicalPublicationId)}
        onNotDuplicate={() => queue.notDuplicate.mutate()}
      />
      <div className="flex flex-wrap items-center gap-3 border-t border-border bg-surface-raised/50 px-4 py-4 min-[681px]:px-5">
        <Button
          type="button"
          variant="ghost"
          onClick={() => queue.skip.mutate()}
          disabled={pending}
        >
          <IconArrowRight />
          Skip for now
        </Button>
      </div>
      {error ? <p className="text-danger px-5 pb-4" role="alert">{error.message}</p> : null}
    </section>
  )
}

function PreviousDuplicateCard({ queue }: { queue: DuplicateQueue }) {
  const candidate = queue.previousCandidate!
  return (
    <section className={cardClass} aria-label="Previous duplicate pair">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-surface-raised/70 px-5 py-4">
        <div>
          <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.08em] text-primary">Last resolved pair</span>
          <h2 className="mb-0 mt-0.5 text-base">{statusLabel(candidate)}</h2>
        </div>
      </header>
      <div className="p-4 min-[681px]:p-5">
        <DuplicateDecisionEditor
          projectId={queue.projectId}
          candidate={candidate}
          readOnly={false}
          onResolved={queue.onPreviousRevised}
          onClose={queue.closePrevious}
        />
      </div>
    </section>
  )
}

export function DuplicateQueuePage() {
  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const queue = useDuplicateQueue(projectId)
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectAccess>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  return (
    <Page>
      <StageEyebrow stage="duplicate_review" />
      <h1>Duplicate Review</h1>
      <p className="text-text-muted">
        Candidate duplicate pairs, one at a time. Pairs sharing an exact DOI, PubMed ID, or
        arXiv ID are merged automatically; everything else is shown here for you to compare and
        keep the record you want, or mark as distinct.
      </p>
      {queue.progress ? (
        <CountPill count={queue.progress.remaining}>
          {queue.progress.remaining === 1 ? 'duplicate pair to review' : 'duplicate pairs to review'}
        </CountPill>
      ) : null}
      <p>
        <Link to={`/projects/${projectId}/duplicates/decisions`}>Review or change past decisions</Link>
      </p>
      {project.data?.canManage && project.data.stage === 'duplicate_review' ? (
        <DuplicateDetectionAction projectId={projectId} />
      ) : null}
      {!queue.previousCandidate && queue.lastCompletedItem ? (
        <div className="my-5 flex flex-wrap items-center gap-3">
          <GoBackButton onClick={() => queue.goBack.mutate()} disabled={queue.goBack.isPending}>
            ← Go back to “{queue.lastCompletedItem.title}”
          </GoBackButton>
        </div>
      ) : null}
      {queue.goBack.error ? <p className="text-danger" role="alert">{queue.goBack.error.message}</p> : null}
      {queue.previousCandidate ? (
        <PreviousDuplicateCard queue={queue} />
      ) : !queue.candidate ? (
        <>
          {queue.loadingNext ? <p>Loading the next duplicate pair…</p> : null}
          {!queue.loadingNext && queue.queueEmpty ? (
            <>
              <p>Every duplicate pair in this project has been resolved.</p>
              <Button type="button" variant="secondary" onClick={() => navigate(`/projects/${projectId}`)}>
                Back to project
              </Button>
            </>
          ) : null}
          {!queue.loadingNext && queue.nextError ? (
            <p className="text-danger" role="alert">{queue.nextError}</p>
          ) : null}
        </>
      ) : (
        <ActiveDuplicateCard queue={queue} />
      )}
    </Page>
  )
}
