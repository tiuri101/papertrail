import { tableBaseClass, tableScrollClass } from '../../components/layoutStyles'
import { Fragment, useEffect, useState } from 'react'

import { InfoTooltip } from '../../components/Tooltip'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import {
  type CriterionAgreement,
  type PairwiseAgreement,
  useReviewerAnalysis,
} from './useReviewerAnalysis'

function formatPercent(value: number | null): string {
  return value === null ? 'N/A' : `${Math.round(value * 100)}%`
}

function formatKappa(value: number | null): string {
  return value === null ? 'N/A' : value.toFixed(2)
}

function MetricCard({ label, value, detail, tone = 'default' }: {
  label: string
  value: string | number
  detail?: string
  tone?: 'default' | 'success' | 'warning'
}) {
  const toneClasses = {
    default: 'border-border bg-bg-elevated [&_strong]:text-text',
    success: 'border-success/30 bg-success-container [&_strong]:text-success',
    warning: 'border-warning/30 bg-warning-container [&_strong]:text-warning',
  }
  return (
    <div className={`flex min-h-28 flex-col justify-between gap-2 rounded-md border p-4 ${toneClasses[tone]}`}>
      <span className="text-[0.76rem] font-bold uppercase tracking-[0.04em] text-text-muted">{label}</span>
      <strong className="text-[1.55rem] leading-none">{value}</strong>
      {detail ? <span className="text-[0.76rem] text-text-muted">{detail}</span> : null}
    </div>
  )
}

function AgreementBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-text-muted">N/A</span>
  return (
    <span className="inline-flex min-w-[118px] items-center gap-2">
      <span className="inline-block h-[7px] w-16 overflow-hidden rounded-full bg-border" aria-hidden="true">
        <span className="block h-full rounded-[inherit] bg-success" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span>{formatPercent(value)}</span>
    </span>
  )
}

function PairwiseTable({ pairs }: { pairs: PairwiseAgreement[] }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  if (pairs.length === 0) {
    return <p className="text-text-muted">No overlapping reviewer pairs yet.</p>
  }
  return (
    <table className={`${tableBaseClass} min-w-[650px]`}>
      <thead>
        <tr>
          <th scope="col">Reviewer pair</th>
          <th scope="col">
            Publications compared
            <InfoTooltip text="How many publications both reviewers in this pair independently decided." />
          </th>
          <th scope="col">Raw agreement</th>
          <th scope="col">
            Cohen&apos;s kappa
            <InfoTooltip text="Chance-corrected agreement. Shown as N/A when mathematically undefined -- for example when the reviewers always chose the same single outcome (expected agreement is 1), never shown as 0." />
          </th>
        </tr>
      </thead>
      <tbody>
        {pairs.map((pair, index) => (
          <Fragment key={`${pair.reviewerA}-${pair.reviewerB}`}>
            <tr>
              <th scope="row">{pair.reviewerA} vs {pair.reviewerB}</th>
              <td>{pair.publicationsCompared}</td>
              <td>{formatPercent(pair.rawAgreementRate)} ({pair.agreeing}/{pair.publicationsCompared})</td>
              <td>
                {formatKappa(pair.cohensKappa)}
                {' '}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setExpanded(expanded === index ? null : index)}
                >
                  {expanded === index ? 'Hide confusion matrix' : 'Show confusion matrix'}
                </Button>
              </td>
            </tr>
            {expanded === index ? (
              <tr>
                <td colSpan={4} className="bg-bg-elevated p-4">
                  <ConfusionMatrixTable pair={pair} />
                </td>
              </tr>
            ) : null}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}

function ConfusionMatrixTable({ pair }: { pair: PairwiseAgreement }) {
  const { categories, rows } = pair.confusionMatrix
  return (
    <table className={`${tableBaseClass} confusion-matrix min-w-0`}>
      <caption className="mb-2 text-left text-[0.8rem] text-text-muted">{pair.reviewerA} (rows) vs {pair.reviewerB} (columns)</caption>
      <thead>
        <tr>
          <th scope="col" />
          {categories.map((category) => <th scope="col" key={category}>{category}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.actual}>
            <th scope="row">{row.actual}</th>
            {categories.map((category) => <td key={category}>{row.counts[category] ?? 0}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function CriteriaTable({ criteria }: { criteria: CriterionAgreement[] }) {
  if (criteria.length === 0) {
    return <p className="text-text-muted">No active criteria with comparable decisions yet.</p>
  }
  return (
    <table className={`${tableBaseClass} min-w-[650px]`}>
      <thead>
        <tr>
          <th scope="col">Criterion</th>
          <th scope="col">Comparable decisions</th>
          <th scope="col">Raw agreement</th>
          <th scope="col">Disagreements</th>
          <th scope="col">Kappa</th>
        </tr>
      </thead>
      <tbody>
        {criteria.map((criterion) => (
          <tr key={criterion.criterionId}>
            <th scope="row">{criterion.criterionText}</th>
            <td>{criterion.comparableDecisions}</td>
            <td><AgreementBar value={criterion.rawAgreementRate} /></td>
            <td>{criterion.disagreementCount}</td>
            <td>{formatKappa(criterion.kappa)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

type ReviewerAnalysisStage = 'title_abstract' | 'full_text'

function StageAnalysis({ projectId, stage, label, enabled }: {
  projectId: string
  stage: ReviewerAnalysisStage
  label: string
  enabled: boolean
}) {
  const query = useReviewerAnalysis(projectId, stage, enabled)
  const data = query.data

  if (!enabled) return null

  if (data && Math.min(data.configuredReviewerCount, data.eligibleReviewerCount) <= 1) return null

  const hasComparablePublications = Boolean(
    data && data.overall.publicationsWithCompleteSet > 0,
  )

  return (
    <div className="mt-7 border-t border-border pt-6">
      <h3 className="mb-3">{label}</h3>
      {query.error ? <p className="text-danger" role="alert">{query.error.message}</p> : null}
      {!data ? (query.isLoading ? <p>Loading…</p> : null) : (
        !hasComparablePublications ? (
          <p className="text-text-muted">
            Agreement analysis will appear after at least two reviewers have completed the same publication.
          </p>
        ) : <>
          <div className="grid grid-cols-1 gap-3 min-[481px]:grid-cols-2 min-[761px]:grid-cols-3">
            <MetricCard
              label="Raw agreement"
              value={formatPercent(data.overall.rawAgreementRate)}
              detail={`${data.overall.totalOriginalDecisions} original decisions`}
              tone="success"
            />
            <MetricCard
              label="Publications compared"
              value={data.overall.publicationsWithCompleteSet}
              detail={`${data.overall.comparingReviewerCount} reviewers`}
            />
            <MetricCard
              label="Publication disagreement"
              value={formatPercent(data.overall.publicationDisagreementRate)}
              detail="At least one differing decision"
              tone="warning"
            />
            <MetricCard label="Uncertain decisions" value={formatPercent(data.overall.uncertainDecisionRate)} />
            <MetricCard
              label="Non-agreement resolutions"
              value={data.overall.nonAgreementResolutionCount}
              detail={formatPercent(data.overall.nonAgreementResolutionRate)}
            />
            <MetricCard label="Revision rate" value={formatPercent(data.overall.revisionRate)} />
          </div>
          <p className="text-[0.82rem] text-text-muted">
            Complete reviewer sets include only publications where every originally-required reviewer slot has a current decision.
            <InfoTooltip text="Conflict-resolution 'additional reviewer' slots are excluded from this comparison." />
          </p>

          {data.pairwise.length > 0 ? (
            <div className="mt-7 overflow-hidden rounded-md border border-border bg-surface">
              <h4 className="m-0 border-b border-border px-4 py-3 text-[0.73rem] font-bold uppercase tracking-[0.08em] text-text-muted">Pairwise reviewer agreement</h4>
              <div className={`${tableScrollClass} m-0 p-4`}><PairwiseTable pairs={data.pairwise} /></div>
            </div>
          ) : null}

          {data.overall.maximumReviewerCount > 2 ? (
            <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface">
              <h4 className="m-0 border-b border-border px-4 py-3 text-[0.73rem] font-bold uppercase tracking-[0.08em] text-text-muted">
                Multi-reviewer agreement
                <InfoTooltip text="Fleiss' kappa across publications with more than two original reviewers deciding, when the reviewer count is consistent enough to calculate. Shown as unavailable, with an explanation, rather than a fabricated value, when it cannot be validly computed." />
              </h4>
              <div className="p-4">
                {data.multiReviewer.kappa !== null ? (
                  <><strong className="text-[1.75rem] text-primary">{formatKappa(data.multiReviewer.kappa)}</strong><span className="text-text-muted"> Fleiss&apos; kappa</span></>
                ) : (
                  <p className="text-text-muted">Unavailable: {data.multiReviewer.unavailableReason ?? 'not enough data'}</p>
                )}
              </div>
            </div>
          ) : null}

          {data.criteria.length > 0 ? (
            <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface">
              <h4 className="m-0 border-b border-border px-4 py-3 text-[0.73rem] font-bold uppercase tracking-[0.08em] text-text-muted">Criterion-level agreement</h4>
              <div className={`${tableScrollClass} m-0 p-4`}><CriteriaTable criteria={data.criteria} /></div>
            </div>
          ) : null}

          {data.disagreementTrend.length > 1 ? (
            <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface">
              <h4 className="m-0 border-b border-border px-4 py-3 text-[0.73rem] font-bold uppercase tracking-[0.08em] text-text-muted">Disagreement over time</h4>
              <div className="m-4 rounded-md border border-border bg-bg-elevated" aria-label="Agreement rate by week">
                <div className="flex min-h-[190px] items-stretch gap-2 overflow-x-auto border-b border-border pt-4 min-[481px]:overflow-visible">
                  {data.disagreementTrend.map((point) => (
                    <div className="flex min-w-[52px] flex-1 flex-col items-center justify-end gap-[5px] overflow-hidden min-[481px]:min-w-[42px]" key={point.bucketStart} title={`${point.bucketStart}: ${formatPercent(point.agreementRate)} agreement`}>
                      <span className="min-h-2 w-[min(34px,70%)] rounded-t-[5px] bg-gradient-to-b from-primary to-primary-strong" style={{ height: `${Math.max(8, Math.round(point.agreementRate * 100))}%` }} />
                      <span className="text-[0.72rem] font-bold text-text-secondary">{formatPercent(point.agreementRate)}</span>
                      <span className="max-w-[76px] overflow-hidden text-ellipsis whitespace-nowrap text-[0.68rem] text-text-muted">{point.bucketStart}</span>
                    </div>
                  ))}
                </div>
                <p className="mx-0 mb-0 mt-3 text-[0.8rem] text-text-muted">Weekly agreement rate across comparable publications.</p>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

export function ReviewerAnalysisSection({
  projectId,
  onVisibilityChange,
  stages = ['title_abstract', 'full_text'],
}: {
  projectId: string
  onVisibilityChange?: (visible: boolean) => void
  stages?: ReviewerAnalysisStage[]
}) {
  const titleAbstractEnabled = stages.includes('title_abstract')
  const fullTextEnabled = stages.includes('full_text')
  const titleAbstract = useReviewerAnalysis(projectId, 'title_abstract', titleAbstractEnabled)
  const fullText = useReviewerAnalysis(projectId, 'full_text', fullTextEnabled)
  const summary = titleAbstract.data?.reviewerSummary ?? []
  const enabledData = [
    titleAbstractEnabled ? titleAbstract.data : null,
    fullTextEnabled ? fullText.data : null,
  ]
  const configsLoaded = (
    (!titleAbstractEnabled || Boolean(titleAbstract.data))
    && (!fullTextEnabled || Boolean(fullText.data))
  )
  const hasMultiReviewerStage = enabledData.some(
    (data) => data && Math.min(data.configuredReviewerCount, data.eligibleReviewerCount) > 1,
  )

  useEffect(() => {
    if (configsLoaded) onVisibilityChange?.(hasMultiReviewerStage)
  }, [configsLoaded, hasMultiReviewerStage, onVisibilityChange])

  if (configsLoaded && !hasMultiReviewerStage) return null

  return (
    <Card as="section" id="section-analysis-reviewer-analysis" className="overflow-hidden">
      <h2>Reviewer Analysis</h2>
      <p className="text-text-muted">
        Anonymized inter-rater agreement for completed screening stages.
      </p>
      <StageAnalysis
        projectId={projectId}
        stage="title_abstract"
        label="Title/Abstract Agreement"
        enabled={titleAbstractEnabled}
      />
      <StageAnalysis
        projectId={projectId}
        stage="full_text"
        label="Full-Text Agreement"
        enabled={fullTextEnabled}
      />

      {titleAbstractEnabled && fullTextEnabled && summary.length > 1 ? (
        <div className="mt-4 overflow-hidden rounded-md border border-border bg-surface p-4">
          <h3 className="mb-3 mt-0">Reviewer summary</h3>
        <div className={`${tableScrollClass} p-0`}><table className={`${tableBaseClass} min-w-[650px]`}>
          <thead>
            <tr>
              <th scope="col">Reviewer</th>
              <th scope="col">Original decisions</th>
              <th scope="col">Revised</th>
              <th scope="col">Revision rate</th>
              <th scope="col">Title/Abstract</th>
              <th scope="col">Full-Text</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((entry) => (
              <tr key={entry.reviewer}>
                <th scope="row">{entry.reviewer}</th>
                <td>{entry.originalDecisions}</td>
                <td>{entry.revisedDecisions}</td>
                <td>{formatPercent(entry.revisionRate)}</td>
                <td>{entry.titleAbstractCount}</td>
                <td>{entry.fullTextCount}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        </div>
      ) : null}
    </Card>
  )
}
