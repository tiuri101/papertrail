import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
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
    <section className={`duplicate-record duplicate-record--${recordLabel.toLowerCase()}`}>
      <header className="duplicate-record__header">
        <span className="duplicate-record__label" aria-hidden="true">{recordLabel}</span>
        <div>
          <h3>Potential Duplicate</h3>
          <p>Record {recordLabel}</p>
        </div>
      </header>
      <dl className="duplicate-record__fields">
        <div className="duplicate-record__title">
          <dt>Title</dt>
          <dd>{publication.title}</dd>
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
    <main className="page">
      <StageEyebrow stage="duplicate_review" />
      <h1>Duplicate Review</h1>
      <p className="muted">
        Candidate duplicate pairs found in this project. Compare each pair and keep the record
        you want, or mark them as not duplicates.
      </p>
      {project.data?.canManage && project.data.stage === 'duplicate_review' ? (
        <DuplicateDetectionAction projectId={projectId} />
      ) : null}
      {candidates.error ? <p className="error" role="alert">{candidates.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      {candidates.data && candidates.data.length > 0 ? (
        <CountPill count={candidates.data.filter((candidate) => candidate.status === 'unresolved').length}>
          unresolved of {candidates.data.length} duplicates
        </CountPill>
      ) : null}
      {candidates.data && candidates.data.length === 0 ? <p className="muted">No duplicates found.</p> : null}
      <ul className="duplicate-review-list">
        {candidates.data?.map((candidate) => (
          <li
            className={`duplicate-review-card${candidate.status === 'unresolved' ? '' : ' duplicate-review-card--resolved'}`}
            key={candidate.id}
          >
            <header className="duplicate-review-card__header">
              <div>
                <span className="eyebrow">Candidate pair</span>
                <h2>Compare publication records</h2>
              </div>
              <span className={`duplicate-review-card__status duplicate-review-card__status--${candidate.status === 'unresolved' ? 'open' : 'resolved'}`}>
                {candidate.status}
              </span>
            </header>
            <div className="duplicate-comparison duplicate-publications">
              <PublicationSummary publication={candidate.publicationA} recordLabel="A" />
              <aside className="duplicate-comparison__evidence" aria-label="Match evidence">
                <h3>Compare</h3>
                <ul>
                  {candidate.matchReasons.map((reason) => (
                    <li key={reason}>
                      <IconCheckCircle />
                      <span>{humanizeMatchReason(reason)}</span>
                    </li>
                  ))}
                </ul>
                <Tooltip className="mt-5 flex" text="How closely the two records match across signals like DOI, title, authors, and publication year. A high score is a strong hint, not proof — always compare the details before merging.">
                  <span className="duplicate-comparison__confidence">
                    <span>Match confidence</span>
                    <span>
                      <progress value={candidate.confidence} max="1" />
                      <strong>{Math.round(candidate.confidence * 100)}% match</strong>
                    </span>
                  </span>
                </Tooltip>
              </aside>
              <PublicationSummary publication={candidate.publicationB} recordLabel="B" />
            </div>
            {candidate.status === 'unresolved' ? (
              <section className="duplicate-decision" aria-labelledby={`duplicate-decision-${candidate.id}`}>
                <div className="duplicate-decision__heading">
                  <h3 id={`duplicate-decision-${candidate.id}`}>Your Decision</h3>
                  <p>Select the record to keep, or confirm that these publications are distinct.</p>
                </div>
                <div className="duplicate-decision__actions">
                  <button
                    type="button"
                    className="duplicate-decision__option duplicate-decision__option--a"
                    aria-label="Keep This One"
                    onClick={() => merge.mutate({ id: candidate.id, canonical: candidate.publicationA.id })}
                    disabled={pending}
                  >
                    <span className="duplicate-decision__option-icon"><IconCheckCircle /></span>
                    <span>
                      <strong>Keep Record A</strong>
                      <small>Merge Record B into A</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="duplicate-decision__option duplicate-decision__option--b"
                    aria-label="Keep This One"
                    onClick={() => merge.mutate({ id: candidate.id, canonical: candidate.publicationB.id })}
                    disabled={pending}
                  >
                    <span className="duplicate-decision__option-icon"><IconCheckCircle /></span>
                    <span>
                      <strong>Keep Record B</strong>
                      <small>Merge Record A into B</small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="duplicate-decision__option duplicate-decision__option--distinct"
                    aria-label="Not a Duplicate"
                    onClick={() => notDuplicate.mutate(candidate.id)}
                    disabled={pending}
                  >
                    <span className="duplicate-decision__option-icon" aria-hidden="true" />
                    <span>
                      <strong>Not a Duplicate</strong>
                      <small>Keep both records separate</small>
                    </span>
                  </button>
                </div>
              </section>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  )
}
