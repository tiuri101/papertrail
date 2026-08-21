import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CountPill } from '../../components/CountPill'
import {
  lastExtractionKey,
  loadLastCompletedItem,
  saveLastCompletedItem,
  type LastCompletedItem,
} from '../../lib/lastCompletedItem'
import { StageEyebrow } from '../projects/StageEyebrow'
import { ExtractionWorkspace } from './ExtractionWorkspace'

interface ExtractionProgress {
  assigned: number
  completed: number
  remaining: number
  claimMode: boolean
}

export function ExtractionPage() {
  const { projectId = '', itemId } = useParams()
  const [lastCompletedItem, setLastCompletedItem] = useState<LastCompletedItem | null>(
    () => (projectId ? loadLastCompletedItem(lastExtractionKey(projectId)) : null),
  )
  const progress = useQuery({
    queryKey: ['extraction-progress', projectId],
    queryFn: () => apiRequest<ExtractionProgress>(`/api/v1/projects/${projectId}/extraction/progress`),
    enabled: Boolean(projectId),
  })

  return (
    <main className="page">
      <StageEyebrow stage="extraction_quality" />
      <h1>Data Extraction</h1>
      {progress.data ? (
        <CountPill count={progress.data.claimMode ? progress.data.remaining : progress.data.completed}>
          {progress.data.claimMode
            ? `paper${progress.data.remaining === 1 ? '' : 's'} remaining`
            : `of ${progress.data.assigned} assigned papers extracted`}
        </CountPill>
      ) : null}
      {!itemId && lastCompletedItem ? (
        <p>
          <Link to={`/projects/${projectId}/extraction/review/${lastCompletedItem.id}`}>
            ← Go back to “{lastCompletedItem.title}”
          </Link>
        </p>
      ) : null}
      <ExtractionWorkspace
        projectId={projectId}
        itemId={itemId}
        onSubmitted={({ id, publicationTitle }) => {
          progress.refetch()
          if (!itemId) {
            const completed = { id, title: publicationTitle }
            setLastCompletedItem(completed)
            saveLastCompletedItem(lastExtractionKey(projectId), completed)
          }
        }}
      />
    </main>
  )
}
