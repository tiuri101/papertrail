import { tableBaseClass, tableScrollClass } from '../../components/layoutStyles'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ActionListItem } from '../../components/ActionListItem'
import { actionListItemClass } from '../../components/actionListStyles'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { ConfirmButton } from '../../components/ConfirmButton'
import { DoiPill } from '../../components/DoiPill'
import { cardStyles } from '../../components/Card'
import { pageStyles } from '../../components/Page'
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
import type { AuditEvent } from '../audit/types'
import { FullTextDocumentPanel } from '../fulltext/FullTextDocumentPanel'
import { AdministrationEyebrow } from '../projects/StageEyebrow'
import { useCanManageProject, useCanManagePublications } from '../../hooks/useCanManageProject'
import { isSafeHttpUrl } from '../../lib/safeUrl'
import { cn } from '../../lib/cn'
import { PublicationEditForm } from './PublicationsPage'
import { PublicationReviewDetails } from './PublicationReviewDetails'
import {
  activeScreeningStage,
  primaryStage,
  screeningLabel,
  type Publication,
} from './publicationShared'
import { TabList, TabPanel } from '../../components/Tabs'

const dangerQuickActionItemClass = actionListItemClass({ size: 'md', danger: true })

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
    return <main className={pageStyles}><p>Loading…</p></main>
  }
  if (!publication) {
    return (
      <main className={pageStyles}>
        <AdministrationEyebrow />
        <h1>Publication not found</h1>
        <p className="text-text-muted">
          It may have been deleted or merged into another record.{' '}
          <Button as={Link} to={`/projects/${projectId}/publications`} variant="text">Back to Publications</Button>
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
      <main className={pageStyles}>
        <AdministrationEyebrow />
        <p>
          {openedFromList ? (
            <Button as={Link} to={`/projects/${projectId}/publications`} variant="text">← Back to Publications</Button>
          ) : (
            <Button type="button" variant="text" onClick={closeEditing}>← Back to Publication</Button>
          )}
        </p>
        <h1>Edit publication</h1>
        <div className={cardStyles} data-ui="card">
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

  return (
      <main className={pageStyles}>
      <AdministrationEyebrow />
      <p><Button as={Link} to={`/projects/${projectId}/publications`} variant="text">← Back to Publications</Button></p>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 min-[961px]:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 max-[960px]:contents">
          <header className="mb-5 max-[960px]:order-1">
            <h1>{publication.title}</h1>
            <p className="mb-0 mt-1 text-text-secondary">{publication.authors ?? 'Unknown authors'}</p>
            <p className="text-text-muted mb-3 mt-1">
              {[
                [publication.publicationYear, publication.venue].filter(Boolean).join(', '),
                publication.publicationType,
              ].filter(Boolean).join(' · ')}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant={stage.variant}>{stage.label}</Badge>
              <PdfAvailabilityPill
                available={Boolean(publication.fullText?.available)}
                href={`/api/v1/projects/${projectId}/publications/${publication.id}/full-text/content`}
                pageCount={publication.fullText?.document?.pageCount}
              />
              {hasData ? <Badge variant="success">Has Data</Badge> : null}
              <DoiPill doi={publication.doi} />
              {isSafeHttpUrl(publication.publisherUrl) ? (
                <PublisherLinkPill url={publication.publisherUrl!} />
              ) : null}
            </div>
          </header>

          <TabList
            idPrefix="publication-detail"
            label="Publication sections"
            activeId={activeTab}
            onSelect={(id) => setActiveTab(id as typeof activeTab)}
            className="mb-6 max-[960px]:order-3 max-[960px]:justify-self-start"
            items={DETAIL_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
          />

          <TabPanel
            idPrefix="publication-detail"
            id={activeTab}
            className="max-[960px]:order-4 max-[960px]:min-w-0 max-[960px]:max-w-full"
          >
            {activeTab === 'overview' ? (
              <div className="grid min-w-0 max-w-full gap-5">
                <section className="min-w-0 max-w-full">
                  <h3 className="mb-2 mt-0">Abstract</h3>
                  <p className="max-w-full leading-relaxed [overflow-wrap:anywhere]">
                    {publication.abstract?.trim() || 'No abstract available.'}
                  </p>
                </section>
                {subjects.length ? (
                  <section className="min-w-0 max-w-full">
                    <h3 className="mb-2 mt-0">Subjects</h3>
                    {/* `!` needed on whitespace-normal: Badge's own base class always sets
                        `whitespace-nowrap`, and Tailwind v4 doesn't resolve two same-property
                        utilities by className order. */}
                    <div className="flex min-w-0 max-w-full flex-wrap gap-2">
                      {subjects.map((subject) => (
                        <Badge key={subject} variant="primary" className="max-w-full [overflow-wrap:anywhere] whitespace-normal!">
                          {subject}
                        </Badge>
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            {activeTab === 'details' ? (
              <div className={tableScrollClass}>
                <table className={tableBaseClass}>
                  <caption className="sr-only">Publication details</caption>
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DETAIL_FIELDS.map((field) => {
                      const value = field.value(publication)
                      return (
                        <tr key={field.label}>
                          <th scope="row">{field.label}</th>
                          <td>
                            {!value ? (
                              <span className="text-text-muted">-</span>
                            ) : field.label === 'DOI' ? (
                              <a href={`https://doi.org/${value}`} target="_blank" rel="noopener noreferrer">{value}</a>
                            ) : (
                              value
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            {activeTab === 'history' ? (
              <div className="grid gap-6 [&_h3]:mb-3 [&_h3]:mt-0">
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
                    <p className="text-text-muted">Only the project owner or an administrator can view the activity log.</p>
                  ) : audit.isLoading || reviewDetails.isLoading ? (
                    <p>Loading…</p>
                  ) : publicationHistory.length === 0 ? (
                    <p className="text-text-muted">No recorded history for this publication yet.</p>
                  ) : (
                    <div className={tableScrollClass}>
                      <table className={tableBaseClass}>
                        <caption className="sr-only">Activity log</caption>
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
                              <td>{event.actorUsername ?? <span className="text-text-muted">System</span>}</td>
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
                <p className="text-text-muted">No PDF has been attached to this publication yet.</p>
              )
            ) : null}
          </TabPanel>
        </div>

        <aside className="sticky top-[92px] grid gap-4 max-[960px]:static max-[960px]:order-2 max-[960px]:min-w-0 max-[960px]:max-w-full">
          <section className={cn(cardStyles, '[&_h2]:mb-3 [&_h2]:mt-0')} data-ui="card">
            <h2>Review Status</h2>
            <dl className="grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[0.85rem] text-text-muted">Stage</dt>
                <dd className="m-0"><Badge variant={stage.variant}>{stage.label}</Badge></dd>
              </div>
              {activeStage ? (
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[0.85rem] text-text-muted">Your decision</dt>
                  <dd className="m-0">
                    <OutcomeBadge
                      outcome={yourDecision?.outcome}
                      label={screeningLabel(yourDecision?.outcome)}
                    />
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className={cn(cardStyles, '[&_h2]:mb-3 [&_h2]:mt-0')} data-ui="card">
            <h2>Quick Actions</h2>
            <div className="grid gap-0.5">
              {publication.fullText?.available ? (
                <ActionListItem
                  as="a"
                  size="md"
                  href={`/api/v1/projects/${projectId}/publications/${publicationId}/full-text/content`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <IconFile /> View PDF
                </ActionListItem>
              ) : null}
              {canManage ? (
                <ActionListItem type="button" size="md" onClick={() => setEditing(true)}>
                  <IconEdit /> Edit Metadata
                </ActionListItem>
              ) : null}
              {canManage ? (
                <ActionListItem
                  type="button"
                  size="md"
                  onClick={() => enrich.mutate()}
                  disabled={enrich.isPending || !publication.doi}
                >
                  <IconSparkle /> Enrich Metadata
                </ActionListItem>
              ) : null}
              <ActionListItem
                as="a"
                size="md"
                href={`/api/v1/projects/${projectId}/publications/${publicationId}/export/bib`}
                target="_blank"
                rel="noreferrer"
              >
                <IconDownload /> Export BibTeX
              </ActionListItem>
              {canManage ? (
                <ConfirmButton
                  label="Delete Publication"
                  variant="danger"
                  className={dangerQuickActionItemClass}
                  warning={`Delete "${publication.title}"? This cannot be undone.`}
                  onConfirm={() => remove.mutate()}
                  disabled={remove.isPending}
                  icon={<IconTrash />}
                />
              ) : null}
            </div>
            {enrich.isSuccess ? <p className="text-text-muted">Enrichment queued.</p> : null}
            {enrich.error ? <p className="text-danger" role="alert">{enrich.error.message}</p> : null}
            {remove.error ? <p className="text-danger" role="alert">{remove.error.message}</p> : null}
          </section>
        </aside>
      </div>
    </main>
  )
}
