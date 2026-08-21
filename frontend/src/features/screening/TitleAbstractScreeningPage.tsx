import { toolbarClass } from '../../components/layoutStyles'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { Button } from '../../components/Button'
import { Page } from '../../components/Page'
import { CountPill } from '../../components/CountPill'
import { GoBackButton } from '../../components/GoBackButton'
import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { StageEyebrow } from '../projects/StageEyebrow'
import { PreviousItemCard } from './PreviousItemCard'
import { ScreeningItemCard } from './ScreeningItemCard'
import { useScreeningQueue } from './useScreeningQueue'

const STAGE = 'title_abstract'

// The counterpart page for the full-text stage is FullTextPage, which
// combines PDF retrieval triage with full-text screening rather than
// reusing this page — see FullTextPage.tsx.
export function TitleAbstractScreeningPage() {
  const { projectId = '' } = useParams()
  const navigate = useNavigate()
  const highlightKeywords = useHighlightKeywords(projectId)
  const queue = useScreeningQueue(projectId, STAGE)

  return (
    <Page>
      <StageEyebrow stage="title_abstract_screening" />
      <h1>Title and Abstract Screening</h1>
      {queue.progress ? (
        <CountPill count={queue.progress.claimMode ? queue.progress.remaining : queue.progress.completed}>
          {queue.progress.claimMode
            ? `paper${queue.progress.remaining === 1 ? '' : 's'} remaining`
            : `of ${queue.progress.assigned} assigned papers screened`}
        </CountPill>
      ) : null}
      <p><Link to={`/projects/${projectId}/screening/${STAGE}/my-decisions`}>Review or change my past decisions</Link></p>
      {!queue.previousItem && queue.lastCompletedItem ? (
        <div className={toolbarClass}>
          <GoBackButton onClick={() => queue.goBack.mutate()} disabled={queue.goBack.isPending}>
            ← Go back to “{queue.lastCompletedItem.title}”
          </GoBackButton>
        </div>
      ) : null}
      {queue.goBack.error ? <p className="text-danger" role="alert">{queue.goBack.error.message}</p> : null}
      {queue.previousItem ? (
        <PreviousItemCard
          projectId={projectId}
          stage={STAGE}
          previousItem={queue.previousItem}
          highlightKeywords={highlightKeywords}
          onClose={queue.closePrevious}
          save={queue.savePreviousDecision}
        />
      ) : !queue.item ? (
        <>
          {queue.loadingNext ? <p>Loading the next publication…</p> : null}
          {!queue.loadingNext && queue.queueEmpty ? (
            <>
              <p>You have completed all of your assigned screening work.</p>
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
        <ScreeningItemCard {...queue} highlightKeywords={highlightKeywords} />
      )}
    </Page>
  )
}
