import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { DoiPill } from '../../components/DoiPill'
import {
  IconDownload,
  IconEdit,
  IconFile,
  IconSparkle,
  IconTrash,
} from '../../components/icons'
import { OutcomeBadge } from '../../components/OutcomeBadge'
import { PdfAvailabilityPill } from '../../components/PdfAvailabilityPill'
import { PublisherLinkPill } from '../../components/PublisherLinkPill'
import { useSession } from '../auth/sessionQuery'
import { FullTextDocumentPanel } from '../fulltext/FullTextDocumentPanel'
import { AdministrationEyebrow } from '../projects/StageEyebrow'
import { useCanManageProject, useCanManagePublications } from '../../hooks/useCanManageProject'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { PublicationEditForm } from './PublicationsPage'
import { PublicationReviewDetails } from './PublicationReviewDetails'
import {
  activeScreeningStage,
  primaryStage,
  screeningLabel,
  type Publication,
} from './publicationShared'

interface AuditEvent {
  id: string
  createdAt: string
  actorUsername: string | null
  action: string
  entityType: string
  entityId: string | null
  summary: string
  metadata: Record<string, unknown>
}

interface FinalExtraction {
  id: string
  publicationId: string
  answers: Record<string, unknown>
  note: string | null
  createdAt: string
}

interface ReviewDetails {
  screening: {
    titleAbstract: {
      finalDecision: {
        outcome: string
        resolutionMethod: string
        note: string | null
        resolvedBy: string | null
        resolvedAt: string | null
      } | null
      reviewerDecisions: Array<{
        workItemId: string
        reviewerName: string
        outcome: string
        version: number
        createdAt: string
      }>
    } | null
    fullText: {
      finalDecision: {
        outcome: string
        resolutionMethod: string
        note: string | null
        resolvedBy: string | null
        resolvedAt: string | null
      } | null
      reviewerDecisions: Array<{
        workItemId: string
        reviewerName: string
        outcome: string
        version: number
        createdAt: string
      }>
    } | null
  }
}

interface PublicationActivityEntry {
  id: string
  createdAt: string
  actorUsername: string | null
  summary: string
}

type DetailTabId = 'overview' | 'details' | 'history' | 'files'

const DETAIL_TABS: Array<{ id: DetailTabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'details', label: 'Details' },
  { id: 'history', label: 'History' },
  { id: 'files', label: 'Files' },
]

const DETAIL_FIELDS: Array<{ label: string; value: (publication: Publication) => string | number | null }> = [
  { label: 'Venue', value: (publication) => publication.venue },
  { label: 'Publication type', value: (publication) => publication.publicationType },
  { label: 'DOI', value: (publication) => publication.doi },
  { label: 'Publisher URL', value: (publication) => publication.publisherUrl },
  { label: 'ISBN', value: (publication) => publication.isbn },
  { label: 'ISSN', value: (publication) => publication.issn },
  { label: 'PubMed ID', value: (publication) => publication.pubmedId },
  { label: 'arXiv ID', value: (publication) => publication.arxivId },
  { label: 'PDF pages', value: (publication) => publication.fullText?.document?.pageCount ?? null },
]

function subjectsFrom(keywords: string | null): string[] {
  if (!keywords) return []
  return keywords.split(/[,;]/).map((part) => part.trim()).filter(Boolean)
}

function screeningStageLabel(stage: 'title_abstract' | 'full_text'): string {
  return stage === 'title_abstract' ? 'Title/Abstract Screening' : 'Full-Text Screening'
}

function activityOutcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    include: 'Included',
    exclude: 'Excluded',
    uncertain: 'Uncertain',
    duplicate: 'Duplicate',
  }
  return labels[outcome] ?? outcome.replaceAll('_', ' ')
}

export function PublicationDetailPage() {
  const { projectId = '', publicationId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const session = useSession()
  const canManage = useCanManagePublications(projectId)
  const canOverride = useCanManageProject(projectId)
  const [activeTab, setActiveTab] = useState<DetailTabId>('overview')
  const [editing, setEditing] = useState(() => searchParams.get('edit') === '1')

  const publications = useQuery({
    queryKey: ['publications', projectId],
    queryFn: () => apiRequest<Publication[]>(`/api/v1/projects/${projectId}/publications`),
    enabled: Boolean(projectId),
  })
  const publication = publications.data?.find((item) => item.id === publicationId)

  const finalExtraction = useQuery({
    queryKey: ['extraction-final', projectId, publicationId],
    queryFn: () => apiRequest<FinalExtraction | null>(
      `/api/v1/projects/${projectId}/extraction/publications/${publicationId}/final`,
    ),
    enabled: Boolean(projectId && publicationId),
  })

  const reviewDetails = useQuery({
    queryKey: ['publication-review-details', projectId, publicationId],
    queryFn: () => apiRequest<ReviewDetails>(
      `/api/v1/projects/${projectId}/publications/${publicationId}/review-details`,
    ),
    enabled: Boolean(projectId && publicationId),
  })

  const audit = useQuery({
    queryKey: ['audit', projectId],
    queryFn: () => apiRequest<AuditEvent[]>(`/api/v1/projects/${projectId}/audit`),
    enabled: Boolean(projectId) && canOverride && activeTab === 'history',
  })

  const remove = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/publications/${publicationId}`, {
      method: 'DELETE',
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['publications', projectId] }),
  })
  const enrich = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/publications/${publicationId}/enrich`, {
      method: 'POST',
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs', projectId] }),
  })

  const publicationHistory = useMemo<PublicationActivityEntry[]>(() => {
    const auditEntries = (audit.data ?? [])
      .filter((event) => event.entityType === 'publication' && event.entityId === publicationId)
      .map((event) => ({
        id: event.id,
        createdAt: event.createdAt,
        actorUsername: event.actorUsername,
        summary: event.summary,
      }))
    const decisionEntries: PublicationActivityEntry[] = []
    const stages = [
      ['Title/Abstract', reviewDetails.data?.screening.titleAbstract],
      ['Full text', reviewDetails.data?.screening.fullText],
    ] as const

    for (const [stageLabel, stageDetails] of stages) {
      for (const decision of stageDetails?.reviewerDecisions ?? []) {
        if (!decision.createdAt) continue
        decisionEntries.push({
          id: `screening-decision-${decision.workItemId}-${decision.version}`,
          createdAt: decision.createdAt,
          actorUsername: decision.reviewerName,
          summary: `${stageLabel} decision: ${activityOutcomeLabel(decision.outcome)}${decision.version > 1 ? ` (version ${decision.version})` : ''}`,
        })
      }
      const final = stageDetails?.finalDecision
      if (final?.resolvedAt) {
        decisionEntries.push({
          id: `final-decision-${stageLabel}-${final.resolvedAt}`,
          createdAt: final.resolvedAt,
          actorUsername: final.resolvedBy,
          summary: `Final ${stageLabel.toLowerCase()} decision: ${activityOutcomeLabel(final.outcome)} (${final.resolutionMethod.replaceAll('_', ' ')})`,
        })
      }
    }

    return [...auditEntries, ...decisionEntries]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
  }, [audit.data, publicationId, reviewDetails.data])

  if (publications.isLoading) {
    return <main className="page"><p>Loading…</p></main>
  }
  if (!publication) {
    return (
      <main className="page">
        <AdministrationEyebrow />
        <h1>Publication not found</h1>
        <p className="muted">
          It may have been deleted or merged into another record.{' '}
          <Link to={`/projects/${projectId}/publications`}>Back to Publications</Link>
        </p>
      </main>
    )
  }

  if (editing && canManage) {
    const openedFromList = searchParams.get('edit') === '1'
    const closeEditing = () => {
      setEditing(false)
      if (openedFromList) {
        const next = new URLSearchParams(searchParams)
        next.delete('edit')
        setSearchParams(next, { replace: true })
      }
    }
    return (
      <main className="page publication-detail">
        <AdministrationEyebrow />
        <p>
          {openedFromList ? (
            <Link to={`/projects/${projectId}/publications`}>← Back to Publications</Link>
          ) : (
            <button type="button" className="link-button" onClick={closeEditing}>← Back to Publication</button>
          )}
        </p>
        <h1>Edit publication</h1>
        <div className="card">
          <PublicationEditForm publication={publication} projectId={projectId} onDone={closeEditing} />
        </div>
      </main>
    )
  }

  const stage = primaryStage(publication)
  const hasData = Boolean(finalExtraction.data)
  const subjects = subjectsFrom(publication.keywords)
  const activeStage = activeScreeningStage(publication)
  const activeStageDetails = activeStage === 'title_abstract'
    ? reviewDetails.data?.screening.titleAbstract
    : activeStage === 'full_text' ? reviewDetails.data?.screening.fullText : null
  const yourDecision = activeStageDetails?.reviewerDecisions.find(
    (decision) => decision.reviewerName === session.data?.user.displayName,
  )
  const screeningActionable = activeStage === 'title_abstract'
    || (activeStage === 'full_text' && Boolean(publication.fullText?.available))
  const screeningHref = activeStage === 'title_abstract'
    ? `/projects/${projectId}/screening/title_abstract`
    : `/projects/${projectId}/full-text`

  return (
    <main className="page publication-detail">
      <AdministrationEyebrow />
      <p><Link to={`/projects/${projectId}/publications`}>← Back to Publications</Link></p>

      <div className="publication-detail__layout">
        <div className="publication-detail__main">
          <header className="publication-detail__header">
            <h1>{publication.title}</h1>
            <p className="publication-detail__authors">{publication.authors ?? 'Unknown authors'}</p>
            <p className="muted publication-detail__meta">
              {[
                [publication.publicationYear, publication.venue].filter(Boolean).join(', '),
                publication.publicationType,
              ].filter(Boolean).join(' · ')}
            </p>
            <div className="publication-card__workflow">
              <span className={`status-badge ${stage.className}`}>{stage.label}</span>
              <PdfAvailabilityPill
                available={Boolean(publication.fullText?.available)}
                href={`/api/v1/projects/${projectId}/publications/${publication.id}/full-text/content`}
                pageCount={publication.fullText?.document?.pageCount}
              />
              {hasData ? <span className="status-badge status-badge--success">Has Data</span> : null}
              <DoiPill doi={publication.doi} />
              {isSafeHttpUrl(publication.publisherUrl) ? (
                <PublisherLinkPill url={publication.publisherUrl!} />
              ) : null}
            </div>
          </header>

          <div className="page-tabs" role="tablist" aria-label="Publication sections">
            {DETAIL_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`publication-detail-tab-${tab.id}`}
                aria-selected={tab.id === activeTab}
                aria-controls={`publication-detail-tabpanel-${tab.id}`}
                className={`page-tab${tab.id === activeTab ? ' page-tab--active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            id={`publication-detail-tabpanel-${activeTab}`}
            className="page-tabpanel"
            role="tabpanel"
            aria-labelledby={`publication-detail-tab-${activeTab}`}
          >
            {activeTab === 'overview' ? (
              <div className="publication-detail__overview">
                <section>
                  <h3>Abstract</h3>
                  <p className="publication-detail__full-abstract">
                    {publication.abstract?.trim() || 'No abstract available.'}
                  </p>
                </section>
                {subjects.length ? (
                  <section>
                    <h3>Subjects</h3>
                    <div className="publication-detail__subjects">
                      {subjects.map((subject) => (
                        <span key={subject} className="status-badge status-badge--primary">{subject}</span>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            {activeTab === 'details' ? (
              <dl className="detail-list">
                {DETAIL_FIELDS.map((field) => {
                  const value = field.value(publication)
                  return (
                    <div key={field.label} className="detail-list__row">
                      <dt>{field.label}</dt>
                      <dd>
                        {!value ? (
                          <span className="muted">-</span>
                        ) : field.label === 'DOI' ? (
                          <a href={`https://doi.org/${value}`} target="_blank" rel="noopener noreferrer">{value}</a>
                        ) : (
                          value
                        )}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            ) : null}

            {activeTab === 'history' ? (
              <div className="publication-detail__history">
                <section>
                  <h3>Screening &amp; Extraction Decisions</h3>
                  <PublicationReviewDetails
                    projectId={projectId}
                    publicationId={publicationId}
                    canManage={canOverride}
                  />
                </section>
                <section>
                  <h3>Activity Log</h3>
                  {!canOverride ? (
                    <p className="muted">Only the project owner or an administrator can view the activity log.</p>
                  ) : audit.isLoading || reviewDetails.isLoading ? (
                    <p>Loading…</p>
                  ) : publicationHistory.length === 0 ? (
                    <p className="muted">No recorded history for this publication yet.</p>
                  ) : (
                    <div className="table-scroll">
                      <table>
                        <caption className="visually-hidden">Activity log</caption>
                        <thead>
                          <tr>
                            <th scope="col">Timestamp</th>
                            <th scope="col">User</th>
                            <th scope="col">Summary</th>
                          </tr>
                        </thead>
                        <tbody>
                          {publicationHistory.map((event) => (
                            <tr key={event.id}>
                              <td>{new Date(event.createdAt).toLocaleString()}</td>
                              <td>{event.actorUsername ?? <span className="muted">System</span>}</td>
                              <td>{event.summary}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            ) : null}

            {activeTab === 'files' ? (
              canManage ? (
                <FullTextDocumentPanel projectId={projectId} publicationId={publicationId} />
              ) : publication.fullText?.available ? (
                <p>
                  <a
                    href={`/api/v1/projects/${projectId}/publications/${publicationId}/full-text/content`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View PDF
                  </a>
                </p>
              ) : (
                <p className="muted">No PDF has been attached to this publication yet.</p>
              )
            ) : null}
          </div>
        </div>

        <aside className="publication-detail__sidebar">
          <section className="card publication-detail__sidebar-card">
            <h2>Review Status</h2>
            <dl className="publication-detail__status-list">
              <div>
                <dt>Stage</dt>
                <dd><span className={`status-badge ${stage.className}`}>{stage.label}</span></dd>
              </div>
              {activeStage ? (
                <div>
                  <dt>Your decision</dt>
                  <dd>
                    <OutcomeBadge
                      outcome={yourDecision?.outcome}
                      label={screeningLabel(yourDecision?.outcome)}
                    />
                  </dd>
                </div>
              ) : null}
            </dl>
            {activeStage ? (
              screeningActionable ? (
                <>
                  <Link className="button-secondary button-md publication-detail__screening-link" to={screeningHref}>
                    Open Screening Queue
                  </Link>
                  <p className="muted publication-detail__screening-note">
                    Claims the next item in the {screeningStageLabel(activeStage)} queue -- not
                    guaranteed to be this publication.
                  </p>
                </>
              ) : (
                <p className="muted publication-detail__screening-note">
                  Awaiting full-text retrieval before it can be screened.
                </p>
              )
            ) : (
              <p className="muted publication-detail__screening-note">Screening complete.</p>
            )}
          </section>

          <section className="card publication-detail__sidebar-card">
            <h2>Quick Actions</h2>
            <div className="publication-detail__quick-actions">
              {publication.fullText?.available ? (
                <a
                  className="publication-detail__quick-action"
                  href={`/api/v1/projects/${projectId}/publications/${publicationId}/full-text/content`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <IconFile /> View PDF
                </a>
              ) : null}
              {canManage ? (
                <button type="button" className="publication-detail__quick-action" onClick={() => setEditing(true)}>
                  <IconEdit /> Edit Metadata
                </button>
              ) : null}
              {canManage ? (
                <button
                  type="button"
                  className="publication-detail__quick-action"
                  onClick={() => enrich.mutate()}
                  disabled={enrich.isPending || !publication.doi}
                >
                  <IconSparkle /> Enrich Metadata
                </button>
              ) : null}
              <a
                className="publication-detail__quick-action"
                href={`/api/v1/projects/${projectId}/publications/${publicationId}/export/bib`}
                target="_blank"
                rel="noreferrer"
              >
                <IconDownload /> Export BibTeX
              </a>
              {canManage ? (
                <ConfirmButton
                  label="Delete Publication"
                  variant="danger"
                  className="publication-detail__quick-action publication-detail__quick-action--danger"
                  warning={`Delete "${publication.title}"? This cannot be undone.`}
                  onConfirm={() => remove.mutate()}
                  disabled={remove.isPending}
                  icon={<IconTrash />}
                />
              ) : null}
            </div>
            {enrich.isSuccess ? <p className="muted">Enrichment queued.</p> : null}
            {enrich.error ? <p className="error" role="alert">{enrich.error.message}</p> : null}
            {remove.error ? <p className="error" role="alert">{remove.error.message}</p> : null}
          </section>
        </aside>
      </div>
    </main>
  )
}
