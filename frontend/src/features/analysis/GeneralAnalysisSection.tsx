import type { CSSProperties, ReactNode } from 'react'

import { IconCheckCircle, IconClock, IconCopy, IconXCircle } from '../../components/icons'
import type {
  DuplicateReviewStats,
  ExtractionQualityStats,
  FullTextStats,
  TitleAbstractStats,
} from './types'
import { useStageAnalysis } from './useStageAnalysis'

interface FunnelStage {
  label: string
  value: number
  detail: string
  tone: string
}

interface StageDetail {
  label: string
  value: number
  detail: string
  icon: ReactNode
  tone: string
}

export interface GeneralAnalysisAvailability {
  duplicateReview: boolean
  titleAbstract: boolean
  fullText: boolean
  extraction: boolean
}

function countFor(items: { label: string; count: number }[], label: string): number {
  return items.find((item) => item.label === label)?.count ?? 0
}

function percentage(value: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((value / total) * 1000) / 10
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`
}

function GeneralMetricCard({ stage }: { stage: FunnelStage }) {
  return (
    <div className={`general-analysis__metric general-analysis__metric--${stage.tone}`}>
      <dt>{stage.label}</dt>
      <dd>
        <strong>{stage.value.toLocaleString()}</strong>
        <span>{stage.detail}</span>
      </dd>
    </div>
  )
}

function ReviewFunnel({ stages }: { stages: FunnelStage[] }) {
  const startingTotal = stages[0]?.value ?? 0
  const maximum = Math.max(startingTotal, 1)

  return (
    <section className="general-analysis__funnel-card" aria-labelledby="general-analysis-funnel-title">
      <h3 id="general-analysis-funnel-title">Review Funnel</h3>
      <ol className="general-analysis__funnel">
        {stages.map((stage) => {
          const width = stage.value > 0
            ? Math.max(22, Math.round((stage.value / maximum) * 100))
            : 18
          return (
            <li key={stage.label}>
              <span className="general-analysis__funnel-label">{stage.label}</span>
              <div className="general-analysis__funnel-track">
                <div
                  className={`general-analysis__funnel-bar general-analysis__funnel-bar--${stage.tone}`}
                  style={{ width: `${width}%` } as CSSProperties}
                >
                  <strong>{stage.value.toLocaleString()}</strong>
                </div>
              </div>
              <span className="general-analysis__funnel-percent">
                {formatPercent(percentage(stage.value, startingTotal))}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function StageDetails({ details }: { details: StageDetail[] }) {
  return (
    <section className="general-analysis__details" aria-labelledby="general-analysis-details-title">
      <h3 id="general-analysis-details-title">Stage Details</h3>
      <dl>
        {details.map((detail) => (
          <div key={detail.label}>
            <dt>
              <span className={`general-analysis__detail-icon general-analysis__detail-icon--${detail.tone}`} aria-hidden="true">
                {detail.icon}
              </span>
              {detail.label}
            </dt>
            <dd>
              <strong>{detail.value.toLocaleString()}</strong>
              <span>{detail.detail}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function GeneralAnalysisSection({
  projectId,
  availability,
}: {
  projectId: string
  availability: GeneralAnalysisAvailability
}) {
  const duplicateReview = useStageAnalysis<DuplicateReviewStats>(
    projectId,
    'duplicate_review',
    availability.duplicateReview,
  )
  const titleAbstract = useStageAnalysis<TitleAbstractStats>(
    projectId,
    'title_abstract_screening',
    availability.titleAbstract,
  )
  const fullText = useStageAnalysis<FullTextStats>(
    projectId,
    'full_text_screening',
    availability.fullText,
  )
  const extraction = useStageAnalysis<ExtractionQualityStats>(
    projectId,
    'extraction_quality',
    availability.extraction,
  )
  const stats = {
    duplicateReview: duplicateReview.data?.stats,
    titleAbstract: titleAbstract.data?.stats,
    fullText: fullText.data?.stats,
    extraction: extraction.data?.stats,
  }
  const enabledQueries = [
    availability.duplicateReview ? duplicateReview : null,
    availability.titleAbstract ? titleAbstract : null,
    availability.fullText ? fullText : null,
    availability.extraction ? extraction : null,
  ].filter((query) => query !== null)
  const error = enabledQueries.find((query) => query.error)?.error
  const isLoading = enabledQueries.some((query) => query.isLoading)

  if (error) {
    return (
      <section id="section-analysis-general" className="card">
        <h2>General Overview</h2>
        <p className="error" role="alert">{error.message}</p>
      </section>
    )
  }
  if (!availability.duplicateReview) {
    return (
      <section id="section-analysis-general" className="card">
        <h2>General Overview</h2>
        <p className="muted">
          Analysis will appear here after the first review stage, deduplication, is complete.
        </p>
      </section>
    )
  }
  const hasAllAvailableStats = (
    Boolean(stats.duplicateReview)
    && (!availability.titleAbstract || Boolean(stats.titleAbstract))
    && (!availability.fullText || Boolean(stats.fullText))
    && (!availability.extraction || Boolean(stats.extraction))
  )
  if (isLoading || !hasAllAvailableStats || !stats.duplicateReview) {
    return (
      <section id="section-analysis-general" className="card">
        <h2>General Overview</h2>
        <p>Loading review overview…</p>
      </section>
    )
  }

  const imported = stats.duplicateReview.recordsIdentified
  const afterDeduplication = stats.duplicateReview.uniqueRecordsRemaining
  const titleAbstractIncluded = stats.titleAbstract
    ? countFor(stats.titleAbstract.outcomeCounts, 'Included')
    : 0
  const fullTextIncluded = stats.fullText?.includedPublications ?? 0
  const extractionsCompleted = stats.extraction?.completedExtractions ?? 0
  const fullTextExcluded = stats.fullText
    ? countFor(stats.fullText.outcomeCounts, 'Excluded')
    : 0
  const pendingExtractions = stats.extraction
    ? Math.max(0, stats.extraction.totalPublications - extractionsCompleted)
    : 0

  const funnelStages: FunnelStage[] = [
    { label: 'Records imported', value: imported, detail: 'Starting set', tone: 'imported' },
    {
      label: 'After deduplication',
      value: afterDeduplication,
      detail: `${formatPercent(percentage(afterDeduplication, imported))} retained`,
      tone: 'deduplicated',
    },
  ]
  if (availability.titleAbstract && stats.titleAbstract) funnelStages.push({
    label: 'Included (Title/Abstract)',
    value: titleAbstractIncluded,
    detail: `${formatPercent(percentage(titleAbstractIncluded, afterDeduplication))} retained`,
    tone: 'title-abstract',
  })
  if (availability.fullText && stats.fullText) funnelStages.push({
    label: 'Included (Full-Text)',
    value: fullTextIncluded,
    detail: `${formatPercent(percentage(fullTextIncluded, titleAbstractIncluded))} retained`,
    tone: 'full-text',
  })
  if (availability.extraction && stats.extraction) funnelStages.push({
    label: 'Extractions completed',
    value: extractionsCompleted,
    detail: `${formatPercent(percentage(extractionsCompleted, fullTextIncluded))} complete`,
    tone: 'extraction',
  })
  const stageDetails: StageDetail[] = [
    {
      label: 'Duplicates removed',
      value: stats.duplicateReview.duplicatesRemoved,
      detail: formatPercent(percentage(stats.duplicateReview.duplicatesRemoved, imported)),
      icon: <IconCopy />,
      tone: 'success',
    },
  ]
  if (availability.titleAbstract && stats.titleAbstract) stageDetails.push({
    label: 'Title/Abstract excluded',
    value: stats.titleAbstract.recordsExcluded,
    detail: formatPercent(percentage(stats.titleAbstract.recordsExcluded, stats.titleAbstract.recordsScreened)),
    icon: <IconXCircle />,
    tone: 'danger',
  })
  if (availability.fullText && stats.fullText) stageDetails.push({
    label: 'Full-Text excluded',
    value: fullTextExcluded,
    detail: formatPercent(percentage(fullTextExcluded, stats.fullText.reportsAssessed)),
    icon: <IconXCircle />,
    tone: 'warning',
  })
  if (availability.extraction && stats.extraction) stageDetails.push({
    label: 'Pending extractions',
    value: pendingExtractions,
    detail: formatPercent(percentage(pendingExtractions, stats.extraction.totalPublications)),
    icon: pendingExtractions ? <IconClock /> : <IconCheckCircle />,
    tone: pendingExtractions ? 'pending' : 'success',
  })

  return (
    <section id="section-analysis-general" className="card general-analysis">
      <h2>General Overview</h2>
      <p className="muted">A summary of results from completed review stages.</p>
      <dl className="general-analysis__metrics">
        {funnelStages.map((stage) => <GeneralMetricCard key={stage.label} stage={stage} />)}
      </dl>
      <div className="general-analysis__body">
        <ReviewFunnel stages={funnelStages} />
        <StageDetails details={stageDetails} />
      </div>
    </section>
  )
}
