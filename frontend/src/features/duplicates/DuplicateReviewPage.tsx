import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Page } from '../../components/Page'
import { CountPill } from '../../components/CountPill'
import { DoiPill } from '../../components/DoiPill'
import { IconCheckCircle } from '../../components/icons'
import { Tooltip } from '../../components/Tooltip'
import { StageEyebrow } from '../projects/StageEyebrow'
import { DuplicateDetectionAction } from './DuplicateDetectionAction'

interface CandidatePublication {
  id: string
  title: string
  authors: string | null
  publicationYear: number | null
  venue: string | null
  doi: string | null
}

interface Candidate {
  id: string
  publicationA: CandidatePublication
  publicationB: CandidatePublication
  matchReasons: string[]
  confidence: number
  status: string
}

interface ProjectAccess {
  canManage: boolean
  stage: string
}

const MATCH_REASON_LABELS: Record<string, string> = {
  exact_doi: 'Exact DOI',
  exact_pubmed_id: 'Exact PubMed ID',
  exact_arxiv_id: 'Exact arXiv ID',
  exact_title: 'Exact title match',
  similar_title: 'Similar title',
  similar_title_authors: 'Similar title & authors',
  similar_title_year: 'Similar title & year',
  shared_isbn: 'Shared ISBN',
  shared_issn: 'Shared ISSN',
}

function humanizeMatchReason(reason: string): string {
  return MATCH_REASON_LABELS[reason] ?? reason.replace(/_/g, ' ')
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

export function DuplicateReviewPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectAccess>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  const candidates = useQuery({
    queryKey: ['duplicates', projectId],
    queryFn: () => apiRequest<Candidate[]>(
      `/api/v1/projects/${projectId}/duplicates`,
    ),
    enabled: Boolean(projectId),
  })
  const refreshCandidates = () => queryClient.invalidateQueries({
    queryKey: ['duplicates', projectId],
  })
  const notDuplicate = useMutation({
    mutationFn: (id: string) => apiRequest(
      `/api/v1/projects/${projectId}/duplicates/${id}/not-duplicate`,
      {
        method: 'POST',
        body: JSON.stringify({ note: null }),
      },
    ),
    onSuccess: refreshCandidates,
  })
  const merge = useMutation({
    mutationFn: ({ id, canonical }: { id: string; canonical: string }) =>
      apiRequest(`/api/v1/projects/${projectId}/duplicates/${id}/merge`, {
        method: 'POST',
        body: JSON.stringify({ canonicalPublicationId: canonical }),
      }),
    onSuccess: refreshCandidates,
  })

  const mutationError = notDuplicate.error ?? merge.error
  const pending = notDuplicate.isPending || merge.isPending

  return (
    <Page>
      <StageEyebrow stage="duplicate_review" />
      <h1>Duplicate Review</h1>
      <p className="text-text-muted">
        Candidate duplicate pairs found in this project. Compare each pair and keep the record
        you want, or mark them as not duplicates.
      </p>
      {project.data?.canManage && project.data.stage === 'duplicate_review' ? (
        <DuplicateDetectionAction projectId={projectId} />
      ) : null}
      {candidates.error ? <p className="text-danger" role="alert">{candidates.error.message}</p> : null}
      {mutationError ? <p className="text-danger" role="alert">{mutationError.message}</p> : null}
      {candidates.data && candidates.data.length > 0 ? (
        <CountPill count={candidates.data.filter((candidate) => candidate.status === 'unresolved').length}>
          unresolved of {candidates.data.length} duplicates
        </CountPill>
      ) : null}
      {candidates.data && candidates.data.length === 0 ? <p className="text-text-muted">No duplicates found.</p> : null}
      <ul className="mt-6 mb-6 grid list-none gap-6 overflow-hidden rounded-md border border-border bg-surface p-0" aria-label="Duplicate candidates">
        {candidates.data?.map((candidate) => (
          <li
            className="overflow-hidden rounded-lg border border-border bg-surface/90 px-5 py-4 shadow-sm data-[resolved=true]:opacity-70"
            data-resolved={candidate.status !== 'unresolved'}
            key={candidate.id}
          >
            <header className="flex items-center justify-between gap-4 border-b border-border bg-surface-raised/70 px-5 py-4 max-[680px]:p-4">
              <div>
                <span className="mb-1 block text-xs font-extrabold uppercase tracking-[0.08em] text-primary">Candidate pair</span>
                <h2 className="mb-0 mt-0.5 text-base">Compare publication records</h2>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold capitalize ${candidate.status === 'unresolved' ? 'bg-warning-container text-warning' : 'bg-success-container text-success'}`}>
                {candidate.status}
              </span>
            </header>
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
            {candidate.status === 'unresolved' ? (
              <section className="border-t border-border bg-surface-raised/50 p-4 min-[681px]:p-5" aria-labelledby={`duplicate-decision-${candidate.id}`}>
                <div>
                  <h3 className="m-0" id={`duplicate-decision-${candidate.id}`}>Your Decision</h3>
                  <p className="mb-0 mt-1 text-[0.86rem] text-text-muted">Select the record to keep, or confirm that these publications are distinct.</p>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-3 min-[681px]:grid-cols-3">
                  <button
                    type="button"
                    className="flex min-h-0 w-full min-w-0 items-center justify-start gap-3 rounded-md border border-border bg-bg-elevated px-4 py-3 text-left text-text-secondary shadow-none hover:border-[var(--kw-1-fg)] hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 min-[681px]:min-h-[4.25rem]"
                    aria-label="Keep This One"
                    onClick={() => merge.mutate({ id: candidate.id, canonical: candidate.publicationA.id })}
                    disabled={pending}
                  >
                    <span className="inline-flex size-[1.4rem] shrink-0 items-center justify-center rounded-full border-2 border-[color-mix(in_srgb,var(--kw-1-fg)_62%,var(--color-border))] text-[var(--kw-1-fg)] [&_svg]:size-[0.8rem] [&_svg]:fill-current"><IconCheckCircle /></span>
                    <span className="grid min-w-0 gap-1">
                      <strong className="text-text">Keep Record A</strong>
                      <small className="text-[0.78rem] font-medium text-text-muted">Merge Record B into A</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex min-h-0 w-full min-w-0 items-center justify-start gap-3 rounded-md border border-border bg-bg-elevated px-4 py-3 text-left text-text-secondary shadow-none hover:border-[var(--kw-4-fg)] hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 min-[681px]:min-h-[4.25rem]"
                    aria-label="Keep This One"
                    onClick={() => merge.mutate({ id: candidate.id, canonical: candidate.publicationB.id })}
                    disabled={pending}
                  >
                    <span className="inline-flex size-[1.4rem] shrink-0 items-center justify-center rounded-full border-2 border-[color-mix(in_srgb,var(--kw-4-fg)_62%,var(--color-border))] text-[var(--kw-4-fg)] [&_svg]:size-[0.8rem] [&_svg]:fill-current"><IconCheckCircle /></span>
                    <span className="grid min-w-0 gap-1">
                      <strong className="text-text">Keep Record B</strong>
                      <small className="text-[0.78rem] font-medium text-text-muted">Merge Record A into B</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="flex min-h-0 w-full min-w-0 items-center justify-start gap-3 rounded-md border border-border bg-bg-elevated px-4 py-3 text-left text-text-secondary shadow-none hover:border-border-strong hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 min-[681px]:min-h-[4.25rem]"
                    aria-label="Not a Duplicate"
                    onClick={() => notDuplicate.mutate(candidate.id)}
                    disabled={pending}
                  >
                    <span className="inline-flex size-[1.4rem] shrink-0 items-center justify-center rounded-full border-2 border-border-strong text-text-muted" aria-hidden="true" />
                    <span className="grid min-w-0 gap-1">
                      <strong className="text-text">Not a Duplicate</strong>
                      <small className="text-[0.78rem] font-medium text-text-muted">Keep both records separate</small>
                    </span>
                  </button>
                </div>
              </section>
            ) : null}
          </li>
        ))}
      </ul>
    </Page>
  )
}
