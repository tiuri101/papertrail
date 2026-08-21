import type { CSSProperties, ReactNode } from 'react'

import { Card } from '../../components/Card'
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

const stageToneClasses: Record<string, { accent: string; bar: string }> = {
  imported: { accent: 'before:bg-[#4d9cff] text-[#4d9cff]', bar: 'from-[#4d9cff] to-[#253f70]' },
  deduplicated: { accent: 'before:bg-[#3c86e8] text-[#3c86e8]', bar: 'from-[#3c86e8] to-[#223b68]' },
  'title-abstract': { accent: 'before:bg-[#6675e8] text-[#6675e8]', bar: 'from-[#6675e8] to-[#353d70]' },
  'full-text': { accent: 'before:bg-[#8a63db] text-[#8a63db]', bar: 'from-[#8a63db] to-[#47346c]' },
  extraction: { accent: 'before:bg-success text-success', bar: 'from-[#9a5bd7] to-[#4d3269]' },
}

const detailToneClasses: Record<string, string> = {
  success: 'bg-success-container text-success',
  danger: 'bg-danger-container text-danger',
  warning: 'bg-warning-container text-warning',
  pending: 'bg-warning-container text-warning',
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
    <div className={`relative min-w-0 overflow-hidden rounded-md border border-border bg-bg-elevated p-4 shadow-sm before:absolute before:inset-x-0 before:top-0 before:h-[3px] ${stageToneClasses[stage.tone].accent}`}>
      <dt className="text-[0.78rem] font-bold leading-[1.35] text-text-secondary">{stage.label}</dt>
      <dd className="mt-3 grid gap-2">
        <strong className="text-[clamp(1.45rem,2vw,1.9rem)] leading-none text-text">{stage.value.toLocaleString()}</strong>
        <span className="text-[0.74rem] font-bold">{stage.detail}</span>
      </dd>
    </div>
  )
}

function ReviewFunnel({ stages }: { stages: FunnelStage[] }) {
  const startingTotal = stages[0]?.value ?? 0
  const maximum = Math.max(startingTotal, 1)

  return (
    <section className="min-w-0 rounded-md border border-border bg-bg-elevated p-4 min-[701px]:p-5" aria-labelledby="general-analysis-funnel-title">
      <h3 className="mb-4 text-base" id="general-analysis-funnel-title">Review Funnel</h3>
      <ol className="grid list-none gap-2 p-0">
        {stages.map((stage) => {
          const width = stage.value > 0
            ? Math.max(22, Math.round((stage.value / maximum) * 100))
            : 18
          return (
            <li className="grid grid-cols-[1fr_auto] items-center gap-2 min-[481px]:grid-cols-[minmax(92px,.75fr)_minmax(100px,1.5fr)_minmax(48px,auto)] min-[701px]:grid-cols-[minmax(116px,.7fr)_minmax(160px,2fr)_minmax(58px,auto)] min-[701px]:gap-3" key={stage.label}>
              <span className="text-[0.8rem] font-semibold text-text-secondary">{stage.label}</span>
              <div className="row-start-2 flex h-12 min-w-0 items-center justify-center rounded-sm bg-surface-hover/55 min-[481px]:col-auto min-[481px]:row-auto">
                <div
                  className={`flex h-full min-w-[18%] items-center justify-center bg-gradient-to-b text-white [clip-path:polygon(5%_0,95%_0,88%_100%,12%_100%)] [filter:drop-shadow(0_5px_8px_rgba(0,0,0,.18))] ${stageToneClasses[stage.tone].bar}`}
                  style={{ width: `${width}%` } as CSSProperties}
                >
                  <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.86rem]">{stage.value.toLocaleString()}</strong>
                </div>
              </div>
              <span className="text-right text-[0.78rem] font-bold text-text-muted">
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
    <section className="min-w-0 rounded-md border border-border bg-bg-elevated p-4 min-[701px]:p-5" aria-labelledby="general-analysis-details-title">
      <h3 className="mb-4 text-base" id="general-analysis-details-title">Stage Details</h3>
      <dl className="m-0">
        {details.map((detail) => (
          <div className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0" key={detail.label}>
            <dt className="flex min-w-0 items-center gap-2 text-[0.8rem] font-semibold text-text-secondary">
              <span className={`inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] [&_svg]:size-[13px] [&_svg]:fill-current ${detailToneClasses[detail.tone]}`} aria-hidden="true">
                {detail.icon}
              </span>
              {detail.label}
            </dt>
            <dd className="m-0 grid shrink-0 grid-cols-[auto_auto] gap-2 text-[0.78rem]">
              <strong>{detail.value.toLocaleString()}</strong>
              <span className="text-text-muted">{detail.detail}</span>
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
      <Card as="section" id="section-analysis-general">
        <h2>General Overview</h2>
        <p className="text-danger" role="alert">{error.message}</p>
      </Card>
    )
  }
  if (!availability.duplicateReview) {
    return (
      <Card as="section" id="section-analysis-general">
        <h2>General Overview</h2>
        <p className="text-text-muted">
          Analysis will appear here after the first review stage, deduplication, is complete.
        </p>
      </Card>
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
      <Card as="section" id="section-analysis-general">
        <h2>General Overview</h2>
        <p>Loading review overview…</p>
      </Card>
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
    <Card as="section" id="section-analysis-general">
      <h2>General Overview</h2>
      <p className="text-text-muted">A summary of results from completed review stages.</p>
      <dl className="my-5 grid grid-cols-1 gap-3 min-[481px]:grid-cols-2 min-[701px]:grid-cols-[repeat(auto-fit,minmax(150px,1fr))]">
        {funnelStages.map((stage) => <GeneralMetricCard key={stage.label} stage={stage} />)}
      </dl>
      <div className="grid grid-cols-1 items-stretch gap-4 min-[1101px]:grid-cols-[minmax(0,1.55fr)_minmax(260px,.85fr)]">
        <ReviewFunnel stages={funnelStages} />
        <StageDetails details={stageDetails} />
      </div>
    </Card>
  )
}
