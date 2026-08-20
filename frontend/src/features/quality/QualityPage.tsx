import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CountPill } from '../../components/CountPill'
import { Tooltip } from '../../components/Tooltip'
import { StageEyebrow } from '../projects/StageEyebrow'
import { QualityWorkspace } from './QualityWorkspace'

interface QualityProgress {
  assigned: number
  completed: number
  remaining: number
  claimMode: boolean
}

export function QualityPage() {
  const { projectId = '', itemId } = useParams()
  const [lastScore, setLastScore] = useState<number | null>(null)
  const progress = useQuery({
    queryKey: ['quality-progress', projectId],
    queryFn: () => apiRequest<QualityProgress>(`/api/v1/projects/${projectId}/quality/progress`),
    enabled: Boolean(projectId),
  })

  return (
    <main className="page">
      <StageEyebrow stage="extraction_quality" />
      <h1>Quality Assessment</h1>
      {progress.data ? (
        <CountPill count={progress.data.claimMode ? progress.data.remaining : progress.data.completed}>
          {progress.data.claimMode
            ? `paper${progress.data.remaining === 1 ? '' : 's'} remaining`
            : `of ${progress.data.assigned} assigned papers assessed`}
        </CountPill>
      ) : null}
      {lastScore !== null ? (
        <p>
          Submitted —{' '}
          <Tooltip text="The sum of the points assigned to each answer on this quality-assessment checklist, as configured by your project administrator. There's no universal maximum — check the checklist design for how it's scored.">
            <span>total score: {lastScore}</span>
          </Tooltip>
        </p>
      ) : null}
      <QualityWorkspace
        projectId={projectId}
        itemId={itemId}
        onSubmitted={({ totalScore }) => {
          progress.refetch()
          setLastScore(totalScore)
        }}
      />
    </main>
  )
}
