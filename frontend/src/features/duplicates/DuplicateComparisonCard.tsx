import { DoiPill } from '../../components/DoiPill'
import { IconCheckCircle } from '../../components/icons'
import { Tooltip } from '../../components/Tooltip'
import { humanizeMatchReason } from './matchReasons'
import type { Candidate, CandidatePublication } from './types'

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
          <dt>DOI</dt>
          <dd>{publication.doi ? <DoiPill doi={publication.doi} /> : '—'}</dd>
        </div>
      </dl>
    </section>
  )
}

/**
 * Side-by-side A/B comparison of a duplicate candidate pair, with the match
 * evidence and confidence in the middle. Shared by the one-at-a-time review
 * queue and the "change a past decision" editor on the decisions page.
 */
export function DuplicateComparisonCard({ candidate }: { candidate: Candidate }) {
  return (
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
  )
}
