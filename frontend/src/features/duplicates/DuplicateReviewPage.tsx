import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

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

function PublicationSummary({ publication }: { publication: CandidatePublication }) {
  return (
    <div>
      <p><strong>{publication.title}</strong></p>
      <p className="muted">
        {publication.authors ?? 'Unknown authors'}
        {publication.publicationYear ? ` — ${publication.publicationYear}` : ''}
      </p>
      {publication.venue ? <p className="muted">{publication.venue}</p> : null}
      {publication.doi ? (
        <p><a href={`https://doi.org/${publication.doi}`} target="_blank" rel="noopener noreferrer">DOI</a></p>
      ) : null}
    </div>
  )
}

export function DuplicateReviewPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
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
      <h1>Duplicate Review</h1>
      {candidates.error ? <p className="error" role="alert">{candidates.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      {candidates.data && candidates.data.length === 0 ? <p className="muted">No duplicates found.</p> : null}
      <ul className="card-list stacked">
        {candidates.data?.map((candidate) => (
          <li className="card" key={candidate.id}>
            <p className="muted">
              {candidate.matchReasons.map(humanizeMatchReason).join(', ')} — {Math.round(candidate.confidence * 100)}% match
              {' — '}{candidate.status}
            </p>
            <div className="compare-columns duplicate-publications">
              <div>
                <PublicationSummary publication={candidate.publicationA} />
                {candidate.status === 'unresolved' ? (
                  <div className="toolbar">
                    <button
                      type="button"
                      onClick={() => merge.mutate({ id: candidate.id, canonical: candidate.publicationA.id })}
                      disabled={pending}
                    >
                      Keep This One
                    </button>
                  </div>
                ) : null}
              </div>
              <div>
                <PublicationSummary publication={candidate.publicationB} />
                {candidate.status === 'unresolved' ? (
                  <div className="toolbar">
                    <button
                      type="button"
                      onClick={() => merge.mutate({ id: candidate.id, canonical: candidate.publicationB.id })}
                      disabled={pending}
                    >
                      Keep This One
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            {candidate.status === 'unresolved' ? (
              <div className="toolbar">
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => notDuplicate.mutate(candidate.id)}
                  disabled={pending}
                >
                  Not a Duplicate
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  )
}
