import { Badge } from '../../components/Badge'
import { DoiPill } from '../../components/DoiPill'
import { IconCheckCircle, IconLightbulb, IconXCircle } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { Tooltip } from '../../components/Tooltip'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { humanizeMatchReason } from './matchReasons'
import {
  type Candidate,
  type CandidatePublication,
  type ProviderRecommendation,
  recommendedChoice,
  type UrlCheck,
} from './types'

const URL_KIND_LABELS: Record<UrlCheck['kind'], string> = {
  publisher_url: 'Publisher link',
  doi: 'DOI link',
}

const PROVIDER_SOURCE_LABELS: Record<string, string> = {
  crossref: 'Crossref',
  semantic_scholar: 'Semantic Scholar',
  url_reachability: 'link check',
}

function urlCheckTooltip(check: UrlCheck): string {
  const verdict =
    check.reachable === null
      ? 'Could not be checked'
      : check.reachable
        ? `Reachable${check.statusCode ? ` (HTTP ${check.statusCode})` : ''}`
        : `Unreachable${check.statusCode ? ` (HTTP ${check.statusCode})` : ''}`
  return `${verdict} — ${check.url}`
}

function UrlCheckBadge({ check }: { check: UrlCheck }) {
  const tone =
    check.reachable === null
      ? 'border-border text-text-muted'
      : check.reachable
        ? 'border-[color-mix(in_srgb,var(--color-success)_45%,var(--color-border))] text-success'
        : 'border-[color-mix(in_srgb,var(--color-danger)_45%,var(--color-border))] text-danger'
  const label =
    check.reachable === null ? 'Not checked' : check.reachable ? 'Reachable' : 'Unreachable'
  return (
    <Tooltip text={urlCheckTooltip(check)}>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.72rem] font-semibold ${tone}`}
      >
        <span className="size-3 [&_svg]:size-full [&_svg]:fill-current" aria-hidden="true">
          {check.reachable === false ? <IconXCircle /> : <IconCheckCircle />}
        </span>
        {URL_KIND_LABELS[check.kind]}: {label}
      </span>
    </Tooltip>
  )
}

function PublicationSummary({
  publication,
  recordLabel,
}: {
  publication: CandidatePublication
  recordLabel: 'A' | 'B'
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--record-accent)_32%,var(--color-border))] bg-bg-elevated [--record-accent:var(--kw-1-fg)] data-[record=b]:[--record-accent:var(--kw-4-fg)]" data-record={recordLabel.toLowerCase()}>
      <header className="flex items-center gap-3 border-b border-border bg-[color-mix(in_srgb,var(--record-accent)_8%,var(--color-surface-raised))] p-4">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-sm border border-[color-mix(in_srgb,var(--record-accent)_55%,var(--color-border))] bg-[color-mix(in_srgb,var(--record-accent)_14%,transparent)] text-[1.05rem] font-extrabold text-[var(--record-accent)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--record-accent)_8%,transparent)]" aria-hidden="true">{recordLabel}</span>
        <div>
          <h3 className="m-0 text-[0.95rem]">Potential Duplicate</h3>
          <p className="mb-0 mt-0.5 text-[0.76rem] text-text-muted">Record {recordLabel}</p>
        </div>
        {publication.screened ? (
          <Tooltip
            className="ml-auto"
            text="This record already has screening decisions. Keep it when merging to retain them — they are not moved to the kept record."
          >
            <Badge variant="primary">
              <IconCheckCircle />
              Screened
            </Badge>
          </Tooltip>
        ) : null}
      </header>
      <dl className="m-0 grid gap-4 p-5 [&>div]:min-w-0 [&_dt]:mb-[3px] [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:text-text-muted [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:overflow-wrap-anywhere [&_dd]:text-[0.9rem] [&_dd]:leading-[1.45] [&_dd]:text-text-secondary">
        <div>
          <dt>Title</dt>
          <dd className="text-base! font-bold! text-text!">{publication.title}</dd>
        </div>
        <div>
          <dt>Authors</dt>
          <dd>{publication.authors ?? 'Unknown authors'}</dd>
        </div>
        <div>
          <dt>Year</dt>
          <dd>{publication.publicationYear ?? '—'}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{publication.venue ?? '—'}</dd>
        </div>
        <div>
          <dt>Links</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {publication.doi ? <DoiPill doi={publication.doi} /> : null}
            {isSafeHttpUrl(publication.publisherUrl) ? (
              <PublisherLinkPill url={publication.publisherUrl} />
            ) : null}
            {!publication.doi && !isSafeHttpUrl(publication.publisherUrl) ? '—' : null}
          </dd>
        </div>
        {(publication.urlChecks ?? []).length > 0 ? (
          <div>
            <dt>Link status</dt>
            <dd className="flex flex-wrap gap-2">
              {(publication.urlChecks ?? []).map((check) => (
                <UrlCheckBadge check={check} key={check.kind} />
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  )
}

const RECOMMENDATION_HEADLINE: Record<ProviderRecommendation, string> = {
  merge: 'Suggested: merge this pair',
  distinct: 'Suggested: keep both records',
  uncertain: '',
}

function ProviderRecommendationCallout({ candidate }: { candidate: Candidate }) {
  const recommendation = candidate.providerRecommendation
  if (candidate.status !== 'unresolved' || !recommendation || recommendation === 'uncertain') {
    return null
  }
  const choice = recommendedChoice(candidate)
  const keepLabel = choice === 'a' ? 'keep Record A' : choice === 'b' ? 'keep Record B' : null
  const sourceLabel = candidate.providerRecommendationSource
    ? (PROVIDER_SOURCE_LABELS[candidate.providerRecommendationSource]
      ?? candidate.providerRecommendationSource)
    : null
  return (
    <InfoBox icon={<IconLightbulb />} tone="info" className="mx-4 mb-0 mt-2 min-[961px]:mx-5">
      <h3 className="m-0 text-[0.9rem]">
        {recommendation === 'merge' && keepLabel
          ? `Suggested: ${keepLabel}`
          : RECOMMENDATION_HEADLINE[recommendation]}
      </h3>
      {candidate.providerRecommendationReason ? (
        <p className="mb-0 mt-1 text-[0.84rem] text-text-secondary">
          {candidate.providerRecommendationReason}
          {sourceLabel ? ` (via ${sourceLabel})` : null}
        </p>
      ) : null}
      <p className="mb-0 mt-1 text-[0.78rem] text-text-muted">
        This is only a hint — review the records before deciding.
      </p>
    </InfoBox>
  )
}

/**
 * Side-by-side A/B comparison of a duplicate candidate pair, with the match
 * evidence and confidence in the middle. Shared by the one-at-a-time review
 * queue and the "change a past decision" editor on the decisions page.
 */
export function DuplicateComparisonCard({ candidate }: { candidate: Candidate }) {
  return (
    <>
      <ProviderRecommendationCallout candidate={candidate} />
      <div className="grid grid-cols-1 items-stretch gap-5 p-4 min-[681px]:grid-cols-2 min-[681px]:p-5 min-[961px]:grid-cols-[minmax(0,1fr)_minmax(11rem,.42fr)_minmax(0,1fr)]">
        <PublicationSummary publication={candidate.publicationA} recordLabel="A" />
        <aside className="flex min-w-0 flex-col self-center max-[960px]:col-span-full max-[960px]:row-start-2 max-[960px]:w-full max-[960px]:border-t max-[960px]:border-border max-[960px]:pt-5 min-[961px]:py-3" aria-label="Match evidence">
          <h3 className="mb-4 mt-0 text-left min-[961px]:text-center">Compare</h3>
          <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[681px]:grid-cols-3 min-[961px]:grid-cols-1">
            {candidate.matchReasons.map((reason) => (
              <li className="flex items-center gap-2 text-[0.82rem] font-semibold text-text-secondary" key={reason}>
                <span className="size-4 shrink-0 text-success [&_svg]:size-full [&_svg]:fill-current"><IconCheckCircle /></span>
                <span>{humanizeMatchReason(reason)}</span>
              </li>
            ))}
          </ul>
          <Tooltip className="mt-5 flex" text="How closely the two records match across signals like DOI, title, authors, and publication year. A high score is a strong hint, not proof — always compare the details before merging.">
            <span className="grid w-full cursor-help gap-2 border-t border-border pt-4 text-[0.76rem] text-text-muted">
              <span>Match confidence</span>
              <span className="flex items-center gap-2">
                <progress className="h-[7px] w-full overflow-hidden rounded-full border-0 bg-surface-active accent-success [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-success [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-surface-active [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-success" value={candidate.confidence} max="1" />
                <strong className="shrink-0 whitespace-nowrap text-[0.82rem] text-text">{Math.round(candidate.confidence * 100)}% match</strong>
              </span>
            </span>
          </Tooltip>
        </aside>
        <PublicationSummary publication={candidate.publicationB} recordLabel="B" />
      </div>
    </>
  )
}
