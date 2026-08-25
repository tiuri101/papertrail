import { tableBaseClass, tableCompactClass, tableNarrowClass } from '../../components/layoutStyles'
import { useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { InfoBox } from '../../components/InfoBox'
import { IconChart } from '../../components/icons'

interface ReviewerCount {
  reviewerId: string
  reviewerName: string
  assigned: number
  completed: number
}

interface StageProgress {
  stage: string
  label: string
  reviewers: ReviewerCount[]
}

export function ReviewerProgressPanel({ projectId }: { projectId: string }) {
  const progress = useQuery({
    queryKey: ['reviewer-progress', projectId],
    queryFn: () => apiRequest<StageProgress[]>(
      `/api/v1/projects/${projectId}/reviewer-progress`,
    ),
    enabled: Boolean(projectId),
  })

  return (
    <CollapsibleSection id="section-reviewer-progress" title="Reviewer Progress" icon={<IconChart />}>
      <InfoBox icon={<IconChart />}>
        <p>How many papers each reviewer has been assigned per stage, and how many they've completed.</p>
      </InfoBox>
      {progress.error ? <p className="text-danger" role="alert">{progress.error.message}</p> : null}
      {progress.isLoading ? <p>Loading…</p> : null}
      {progress.data?.map((stage) => (
        <div key={stage.stage}>
          <h3>{stage.label}</h3>
          {stage.reviewers.length === 0 ? (
            <p className="text-text-muted">No reviewers have been assigned work for this stage yet.</p>
          ) : (
            <table className={`${tableBaseClass} ${tableCompactClass} ${tableNarrowClass}`}>
              <thead>
                <tr>
                  <th scope="col">Reviewer</th>
                  <th scope="col">Assigned</th>
                  <th scope="col">Completed</th>
                </tr>
              </thead>
              <tbody>
                {stage.reviewers.map((reviewer) => (
                  <tr key={reviewer.reviewerId}>
                    <td>{reviewer.reviewerName}</td>
                    <td>{reviewer.assigned}</td>
                    <td>{reviewer.completed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </CollapsibleSection>
  )
}
