import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { StageEyebrow } from '../projects/StageEyebrow'
import { PreviousItemCard } from './PreviousItemCard'
import { ScreeningItemCard } from './ScreeningItemCard'
import { useScreeningQueue } from './useScreeningQueue'

export function ScreeningPage() {
  const { projectId = '', stage = 'title_abstract' } = useParams()
  const navigate = useNavigate()
  const highlightKeywords = useHighlightKeywords(projectId)
  const queue = useScreeningQueue(projectId, stage)

  const visibleItemId = queue.previousItem?.id ?? queue.item?.id
  useEffect(() => {
    if (visibleItemId) window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [visibleItemId])

  return (
    <main className="page">
      <StageEyebrow
        stage={stage === 'full_text' ? 'full_text_screening' : 'title_abstract_screening'}
      />
      <h1>
        {stage === 'full_text'
          ? 'Full-Text Screening'
          : 'Title and Abstract Screening'}
      </h1>
      {queue.progress ? (
        <p className="muted">
          {queue.progress.claimMode
            ? `${queue.progress.remaining} papers remaining`
            : `${queue.progress.completed} of ${queue.progress.assigned} assigned papers screened`}
        </p>
      ) : null}
      <p><Link to={`/projects/${projectId}/screening/${stage}/my-decisions`}>Review or change my past decisions</Link></p>
      {!queue.previousItem && queue.lastCompletedItem ? (
        <div className="toolbar">
          <button
            type="button"
            className="button-secondary"
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
          stage={stage}
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
