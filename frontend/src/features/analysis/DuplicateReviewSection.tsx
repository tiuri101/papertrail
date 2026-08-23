import { Card } from '../../components/Card'
import { CompletionBar } from './CompletionBar'
import { FieldBarChart } from './FieldBarChart'
import { StageNarrativePanel } from './StageNarrativePanel'
import type { DuplicateReviewStats } from './types'
import { useStageAnalysis } from './useStageAnalysis'

export function DuplicateReviewSection({ projectId }: { projectId: string }) {
  const query = useStageAnalysis<DuplicateReviewStats>(projectId, 'duplicate_review')
  const stats = query.data?.stats

  return (
    <Card as="section" id="section-analysis-duplicate-review">
      <h2>Deduplication</h2>
      {query.error ? <p className="text-danger" role="alert">{query.error.message}</p> : null}
      {stats ? (
        <>
          <p className="text-text-muted">
            {stats.recordsIdentified} records identified &middot; {stats.duplicatesRemoved} removed
            as duplicates
          </p>
          <CompletionBar
            answered={stats.uniqueRecordsRemaining}
            total={stats.recordsIdentified}
            label="unique records remaining"
          />
          {stats.matchReasonCounts.length ? (
            <>
              <h3>Why records were merged</h3>
              <FieldBarChart
                orientation="horizontal"
                data={stats.matchReasonCounts.map((item) => ({
                  label: item.label,
                  count: item.count,
                }))}
              />
            </>
          ) : null}
        </>
      ) : null}
      {query.data?.narrativeEnabled ? (
        <StageNarrativePanel
          projectId={projectId}
          stage="duplicate_review"
          narrative={query.data.narrative}
          isStale={query.data.isStale}
        />
      ) : null}
    </Card>
  )
}
