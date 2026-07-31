import { useParams } from 'react-router-dom'

import { useHighlightKeywords } from '../../hooks/useHighlightKeywords'
import { ScreeningItemCard } from './ScreeningItemCard'
import { useScreeningQueue } from './useScreeningQueue'

export function ScreeningPage() {
  const { projectId = '', stage = 'title_abstract' } = useParams()
  const highlightKeywords = useHighlightKeywords(projectId)
  const queue = useScreeningQueue(projectId, stage)

  return (
    <main className="page">
      <h1>
        {stage === 'full_text'
          ? 'Full-text screening'
          : 'Title and abstract screening'}
      </h1>
      {!queue.item ? (
        <>
          {queue.loadingNext ? <p>Loading the next publication…</p> : null}
          {!queue.loadingNext && queue.queueEmpty ? <p>No publications are currently available.</p> : null}
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
