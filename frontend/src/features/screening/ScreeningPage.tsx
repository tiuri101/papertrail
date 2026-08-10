import { Link, useNavigate, useParams } from 'react-router-dom'

import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { ScreeningItemCard } from './ScreeningItemCard'
import { useScreeningQueue } from './useScreeningQueue'

export function ScreeningPage() {
  const { projectId = '', stage = 'title_abstract' } = useParams()
  const navigate = useNavigate()
  const highlightKeywords = useHighlightKeywords(projectId)
  const queue = useScreeningQueue(projectId, stage)

  return (
    <main className="page">
      <p className="eyebrow">Review workspace</p>
      <h1>
        {stage === 'full_text'
          ? 'Full-Text Screening'
          : 'Title and Abstract Screening'}
      </h1>
      {queue.progress ? (
        <p className="muted">{queue.progress.completed} of {queue.progress.assigned} assigned papers screened</p>
      ) : null}
      <p><Link to={`/projects/${projectId}/screening/${stage}/my-decisions`}>Review or change my past decisions</Link></p>
      {!queue.item ? (
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
