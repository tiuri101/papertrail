import { Fragment, useState } from 'react'

import { InfoTooltip } from '../../components/Tooltip'
import { Button } from '../../components/Button'
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
  return (
    <div className={`reviewer-analysis-metric reviewer-analysis-metric--${tone}`}>
      <span className="reviewer-analysis-metric__label">{label}</span>
      <strong className="reviewer-analysis-metric__value">{value}</strong>
      {detail ? <span className="reviewer-analysis-metric__detail">{detail}</span> : null}
    </div>
  )
}

function AgreementBar({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">N/A</span>
  return (
    <span className="reviewer-analysis-agreement">
      <span className="reviewer-analysis-agreement__track" aria-hidden="true">
        <span className="reviewer-analysis-agreement__fill" style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span>{formatPercent(value)}</span>
    </span>
  )
}

function PairwiseTable({ pairs }: { pairs: PairwiseAgreement[] }) {
  const [expanded, setExpanded] = useState<number | null>(null)
  if (pairs.length === 0) {
    return <p className="muted">No overlapping reviewer pairs yet.</p>
  }
  return (
    <table className="reviewer-analysis-table">
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
                <td colSpan={4} className="reviewer-analysis-table__expanded">
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
    <table className="confusion-matrix reviewer-analysis-table">
      <caption>{pair.reviewerA} (rows) vs {pair.reviewerB} (columns)</caption>
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
    return <p className="muted">No active criteria with comparable decisions yet.</p>
  }
  return (
    <table className="reviewer-analysis-table">
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

function StageAnalysis({ projectId, stage, label }: {
  projectId: string
  stage: 'title_abstract' | 'full_text'
  label: string
}) {
  const query = useReviewerAnalysis(projectId, stage)
  const data = query.data

  return (
    <div className="reviewer-analysis-stage">
      <h3>{label}</h3>
      {query.error ? <p className="error" role="alert">{query.error.message}</p> : null}
      {!data ? (query.isLoading ? <p>Loading…</p> : null) : (
        <>
          <div className="reviewer-analysis-metrics">
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
          <p className="reviewer-analysis-note">
            Complete reviewer sets include only publications where every originally-required reviewer slot has a current decision.
            <InfoTooltip text="Conflict-resolution 'additional reviewer' slots are excluded from this comparison." />
          </p>

          <div className="reviewer-analysis-subsection">
            <h4>Pairwise reviewer agreement</h4>
            <div className="table-scroll"><PairwiseTable pairs={data.pairwise} /></div>
          </div>

          <div className="reviewer-analysis-subsection">
            <h4>
              Multi-reviewer agreement
              <InfoTooltip text="Fleiss' kappa across publications with more than two original reviewers deciding, when the reviewer count is consistent enough to calculate. Shown as unavailable, with an explanation, rather than a fabricated value, when it cannot be validly computed." />
            </h4>
            <div className="reviewer-analysis-kappa__content">
              {data.multiReviewer.kappa !== null ? (
                <><strong className="reviewer-analysis-kappa__value">{formatKappa(data.multiReviewer.kappa)}</strong><span className="muted"> Fleiss&apos; kappa</span></>
              ) : (
                <p className="muted">Unavailable: {data.multiReviewer.unavailableReason ?? 'not enough data'}</p>
              )}
            </div>
          </div>

          <div className="reviewer-analysis-subsection">
            <h4>Criterion-level agreement</h4>
            <div className="table-scroll"><CriteriaTable criteria={data.criteria} /></div>
          </div>

          <div className="reviewer-analysis-subsection">
            <h4>Disagreement over time</h4>
            {data.disagreementTrend.length === 0 ? (
              <p className="reviewer-analysis-empty">Not enough data yet.</p>
            ) : (
              <div className="reviewer-analysis-trend" aria-label="Agreement rate by week">
                <div className="reviewer-analysis-trend__bars">
                  {data.disagreementTrend.map((point) => (
                    <div className="reviewer-analysis-trend__item" key={point.bucketStart} title={`${point.bucketStart}: ${formatPercent(point.agreementRate)} agreement`}>
                      <span className="reviewer-analysis-trend__bar" style={{ height: `${Math.max(8, Math.round(point.agreementRate * 100))}%` }} />
                      <span className="reviewer-analysis-trend__value">{formatPercent(point.agreementRate)}</span>
                      <span className="reviewer-analysis-trend__label">{point.bucketStart}</span>
                    </div>
                  ))}
                </div>
                <p className="muted reviewer-analysis-trend__caption">Weekly agreement rate across comparable publications.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function ReviewerAnalysisSection({ projectId }: { projectId: string }) {
  const titleAbstract = useReviewerAnalysis(projectId, 'title_abstract')
  const summary = titleAbstract.data?.reviewerSummary ?? []

  return (
    <section id="section-analysis-reviewer-analysis" className="card reviewer-analysis-card">
      <h2>Reviewer Analysis</h2>
      <p className="muted">
        Anonymized inter-rater agreement for title/abstract and full-text screening decisions.
      </p>
      <StageAnalysis projectId={projectId} stage="title_abstract" label="Title/Abstract Agreement" />
      <StageAnalysis projectId={projectId} stage="full_text" label="Full-Text Agreement" />

      <div className="reviewer-analysis-subsection reviewer-analysis-summary">
        <h3>Reviewer summary</h3>
      {summary.length === 0 ? (
        <p className="muted">No comparable reviewer decisions yet.</p>
      ) : (
        <div className="table-scroll"><table className="reviewer-analysis-table">
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
      )}
      </div>
    </section>
  )
}
