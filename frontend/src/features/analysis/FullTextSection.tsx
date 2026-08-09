import { FieldBarChart } from './FieldBarChart'
import { StageNarrativePanel } from './StageNarrativePanel'
import type { FullTextStats } from './types'
import { useStageAnalysis } from './useStageAnalysis'

export function FullTextSection({ projectId }: { projectId: string }) {
  const query = useStageAnalysis<FullTextStats>(projectId, 'full_text_screening')
  const stats = query.data?.stats

  return (
    <section id="section-analysis-full-text" className="card">
      <h2>Full-Text Screening</h2>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {stats ? (
        <>
          <p className="muted">
            {stats.reportsSought} reports sought &middot; {stats.reportsNotRetrieved} not retrieved
            &middot; {stats.reportsAssessed} assessed &middot; {stats.includedPublications} included
          </p>
          <h3>Retrieval status</h3>
          <FieldBarChart
            orientation="horizontal"
            data={stats.retrievalStatusCounts.map((item) => ({
              label: item.label,
              count: item.count,
            }))}
          />
          <h3>Outcomes</h3>
          <FieldBarChart
            orientation="horizontal"
            data={stats.outcomeCounts.map((item) => ({ label: item.label, count: item.count }))}
          />
          {stats.exclusionReasonCounts.length ? (
            <>
              <h3>Why reports were excluded</h3>
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
          stage="full_text_screening"
          narrative={query.data.narrative}
          isStale={query.data.isStale}
        />
      ) : null}
    </section>
  )
}
