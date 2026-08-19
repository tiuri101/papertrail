import { Link, useNavigate, useParams } from 'react-router-dom'

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
    <main className="page">
      <StageEyebrow stage="title_abstract_screening" />
      <h1>Title and Abstract Screening</h1>
      {queue.progress ? (
        <p className="muted">
          {queue.progress.claimMode
            ? `${queue.progress.remaining} papers remaining`
            : `${queue.progress.completed} of ${queue.progress.assigned} assigned papers screened`}
        </p>
      ) : null}
      <p><Link to={`/projects/${projectId}/screening/${STAGE}/my-decisions`}>Review or change my past decisions</Link></p>
      {!queue.previousItem && queue.lastCompletedItem ? (
        <div className="toolbar">
          <button
            type="button"
            className="button-secondary go-back-button"
            onClick={() => queue.goBack.mutate()}
            disabled={queue.goBack.isPending}
          >
            ← Go back to “{queue.lastCompletedItem.title}”
          </button>
        </div>
      ) : null}
      {queue.goBack.error ? <p className="error" role="alert">{queue.goBack.error.message}</p> : null}
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
              <button type="button" className="button-secondary" onClick={() => navigate(`/projects/${projectId}`)}>
                Back to project
              </button>
            </>
          ) : null}
          {!queue.loadingNext && queue.nextError ? (
            <p className="error" role="alert">{queue.nextError}</p>
          ) : null}
        </>
      ) : (
        <ScreeningItemCard {...queue} highlightKeywords={highlightKeywords} />
      )}
    </main>
  )
}
