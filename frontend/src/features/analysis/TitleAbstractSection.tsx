import { FieldBarChart } from './FieldBarChart'
import { StageNarrativePanel } from './StageNarrativePanel'
import type { TitleAbstractStats } from './types'
import { useStageAnalysis } from './useStageAnalysis'

export function TitleAbstractSection({ projectId }: { projectId: string }) {
  const query = useStageAnalysis<TitleAbstractStats>(projectId, 'title_abstract_screening')
  const stats = query.data?.stats

  return (
    <section id="section-analysis-title-abstract" className="card">
      <h2>Title/Abstract Screening</h2>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {stats ? (
        <>
          <p className="muted">
            {stats.recordsScreened} records screened &middot; {stats.recordsExcluded} excluded
          </p>
          <h3>Outcomes</h3>
          <FieldBarChart
            orientation="horizontal"
            data={stats.outcomeCounts.map((item) => ({ label: item.label, count: item.count }))}
          />
          {stats.exclusionReasonCounts.length ? (
            <>
              <h3>Why records were excluded</h3>
              <FieldBarChart
                orientation="horizontal"
                data={stats.exclusionReasonCounts.map((item) => ({
                  label: item.label,
                  count: item.count,
                }))}
              />
            </>
          ) : null}
        </>
      ) : null}
      {query.data ? (
        <StageNarrativePanel
          projectId={projectId}
          stage="title_abstract_screening"
          narrative={query.data.narrative}
          isStale={query.data.isStale}
        />
      ) : null}
    </section>
  )
}
