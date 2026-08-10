import { CompletionBar } from './CompletionBar'
import { FieldBarChart } from './FieldBarChart'
import { StageNarrativePanel } from './StageNarrativePanel'
import type { ExtractionQualityStats, FieldStats, HistogramBin, NumericStats } from './types'
import { useStageAnalysis } from './useStageAnalysis'

function formatRange(bin: HistogramBin): string {
  const round = (value: number) => Math.round(value * 100) / 100
  return `${round(bin.rangeStart)}–${round(bin.rangeEnd)}`
}

function NumericSummary({ stats }: { stats: NumericStats }) {
  return (
    <p className="muted">
      min {stats.min} &middot; max {stats.max} &middot; mean {stats.mean} &middot; median{' '}
      {stats.median}
    </p>
  )
}

function FieldBreakdown({ field }: { field: FieldStats }) {
  return (
    <>
      <h3>{field.label}</h3>
      <p className="muted">{field.source === 'quality' ? 'Quality assessment' : 'Extraction'}</p>
      <CompletionBar answered={field.answeredCount} total={field.totalCount} />
      {field.optionCounts ? (
        <FieldBarChart
          orientation="horizontal"
          data={field.optionCounts.map((item) => ({ label: item.option, count: item.count }))}
        />
      ) : null}
      {field.numericStats ? (
        <>
          <NumericSummary stats={field.numericStats} />
          <FieldBarChart
            orientation="vertical"
            data={field.numericStats.histogram.map((bin) => ({
              label: formatRange(bin),
              count: bin.count,
            }))}
          />
        </>
      ) : null}
    </>
  )
}

export function ExtractionQualitySection({ projectId }: { projectId: string }) {
  const query = useStageAnalysis<ExtractionQualityStats>(projectId, 'extraction_quality')
  const stats = query.data?.stats

  return (
    <section id="section-analysis-extraction-quality" className="card">
      <h2>Extraction &amp; Quality</h2>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {stats ? (
        <>
          <p className="muted">{stats.totalPublications} included publications.</p>
          {stats.qualityTotalScore ? (
            <>
              <h3>Overall quality score</h3>
              <NumericSummary stats={stats.qualityTotalScore} />
              <FieldBarChart
                orientation="vertical"
                data={stats.qualityTotalScore.histogram.map((bin) => ({
                  label: formatRange(bin),
                  count: bin.count,
                }))}
              />
            </>
          ) : null}
          {stats.fields.map((field) => <FieldBreakdown field={field} key={field.id} />)}
        </>
      ) : null}
      {query.data ? (
        <StageNarrativePanel
          projectId={projectId}
          stage="extraction_quality"
          narrative={query.data.narrative}
          isStale={query.data.isStale}
        />
      ) : null}
    </section>
  )
}
