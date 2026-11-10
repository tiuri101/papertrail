import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Card, cardPageSiblingSpacingStyles } from '../../components/Card'
import { cn } from '../../lib/cn'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconInfo, IconRestart } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Page } from '../../components/Page'
import { SectionNavigationLayout } from '../../components/SectionNavigationLayout'
import { ProjectDashboard } from '../administration/ProjectDashboard'
import { DuplicateDetectionAction } from '../duplicates/DuplicateDetectionAction'
import { takesDuplicateDecisions } from '../duplicates/types'
import { type PdfSummary } from '../imports/PdfMatchReview'
import { ProjectChecklistPanel } from './ProjectChecklistPanel'
import { STAGES, StageProgress } from './StageProgress'
import { useProjectDocumentTitle } from './useProjectDocumentTitle'

interface ProjectDetail {
  id: string
  name: string
  stage: string
  archivedAt: string | null
  canManage: boolean
  extractionValidationEnabled: boolean
  canTitleAbstractScreen: boolean
  canFullTextScreen: boolean
  canExtract: boolean
  canAssessQuality: boolean
  canAdjudicate: boolean
}

interface WorkflowIntegrityIssue {
  code: string
  entityId?: string
  message: string
}

interface WorkflowIntegrityResponse {
  issues: WorkflowIntegrityIssue[]
}

interface WorkflowIntegrityRepairResult {
  removedFullTextWorkItems: number
  removedFullTextRetrievals: number
  advancedToExtraction: boolean
  createdExtractionItems: number
  createdQualityItems: number
}

function repairSummaryText(result: WorkflowIntegrityRepairResult): string {
  const parts: string[] = []
  if (result.removedFullTextWorkItems || result.removedFullTextRetrievals) {
    parts.push('cleared stray full-text screening work left over from a reversed decision')
  }
  if (result.advancedToExtraction) {
    parts.push('advanced the project into extraction')
  }
  if (result.createdExtractionItems) {
    parts.push(`created ${result.createdExtractionItems} extraction work item${result.createdExtractionItems === 1 ? '' : 's'}`)
  }
  if (result.createdQualityItems) {
    parts.push(`created ${result.createdQualityItems} quality-assessment work item${result.createdQualityItems === 1 ? '' : 's'}`)
  }
  if (parts.length === 0) return 'Nothing needed to be repaired.'
  return `Repaired: ${parts.join('; ')}.`
}

interface JobStageSummary {
  stage: string
  completed: number
  total: number
  active: boolean
}

interface OpenMetadataConflict {
  id: string
}

const projectMainSections = [
  { id: 'section-project-checklist', label: 'Checklist' },
  { id: 'section-project-actions', label: 'Actions' },
  { id: 'section-project-status', label: 'Project Status' },
]

const STAGE_INDEX: Record<string, number> = {
  draft: 0,
  duplicate_review: 1,
  title_abstract_screening: 2,
  full_text_screening: 3,
  extraction_quality: 4,
  completed: 5,
}

type ProjectCapability =
  | 'canTitleAbstractScreen'
  | 'canFullTextScreen'
  | 'canExtract'
  | 'canAssessQuality'
  | 'canAdjudicate'

interface ProjectSectionLink {
  path: string
  label: string
  alwaysAvailable?: boolean
  managerOnly?: boolean
  validationOnly?: boolean
  requiresCapability?: ProjectCapability
}

interface ProjectSectionGroup {
  heading: string
  stage: string | null
  color?: string
  links: ProjectSectionLink[]
  jobStages?: string[]
}

const projectSectionGroups: ProjectSectionGroup[] = [
  {
    heading: 'Administration',
    stage: null,
    color: 'var(--color-text)',
    links: [
      { path: 'admin', label: 'Project Administration', managerOnly: true },
      { path: 'setup', label: 'Setup Wizard', managerOnly: true },
      { path: 'publications', label: 'Publications' },
      { path: 'jobs', label: 'Jobs' },
    ],
  },
  {
    heading: 'Draft',
    stage: 'draft',
    links: [
      { path: 'research-agenda', label: 'Research Agenda' },
      { path: 'forms', label: 'Forms and Templates', managerOnly: true },
      { path: 'imports', label: 'Searches and Imports' },
    ],
    jobStages: ['Publication import', 'Publication metadata'],
  },
  {
    heading: 'Duplicate Review',
    stage: 'duplicate_review',
    links: [
      { path: 'duplicates', label: 'Review Duplicate Candidates' },
      { path: 'duplicates/decisions', label: 'Review or Change Past Decisions' },
    ],
    jobStages: ['Duplicate review'],
  },
  {
    heading: 'Title/Abstract Screening',
    stage: 'title_abstract_screening',
    links: [
      {
        path: 'screening/title_abstract',
        label: 'Title/Abstract Screening',
        requiresCapability: 'canTitleAbstractScreen',
      },
      {
        path: 'screening/title_abstract/my-decisions',
        label: 'My Title/Abstract Decisions',
        requiresCapability: 'canTitleAbstractScreen',
      },
      { path: 'conflicts/title_abstract', label: 'Title/Abstract Conflicts', managerOnly: true },
    ],
    jobStages: ['Title/abstract screening'],
  },
  {
    heading: 'Full-Text Screening',
    stage: 'full_text_screening',
    links: [
      {
        path: 'full-text',
        label: 'Retrieve & Screen Full Texts',
        requiresCapability: 'canFullTextScreen',
      },
      {
        path: 'screening/full_text/my-decisions',
        label: 'My Full-Text Decisions',
        requiresCapability: 'canFullTextScreen',
      },
      { path: 'conflicts/full_text', label: 'Full-Text Conflicts', managerOnly: true },
    ],
    jobStages: ['Full-text preparation', 'Full-text screening'],
  },
  {
    heading: 'Extraction & Quality',
    stage: 'extraction_quality',
    links: [
      { path: 'extraction', label: 'Data Extraction', requiresCapability: 'canExtract' },
      {
        path: 'extraction/mine',
        label: 'My Submitted Extractions',
        requiresCapability: 'canExtract',
      },
      {
        path: 'extraction/validation',
        label: 'Review LLM Extraction Validation',
        validationOnly: true,
        requiresCapability: 'canExtract',
      },
      {
        path: 'extraction/reconciliation',
        label: 'Extraction Conflicts',
        requiresCapability: 'canAdjudicate',
      },
      { path: 'quality', label: 'Quality Assessment', requiresCapability: 'canAssessQuality' },
      {
        path: 'quality/mine',
        label: 'My Submitted Quality Assessments',
        requiresCapability: 'canAssessQuality',
      },
    ],
    jobStages: ['Data extraction', 'Extraction validation'],
  },
  {
    heading: 'Completed',
    stage: 'completed',
    links: [
      { path: 'results', label: 'Final Results' },
      { path: 'analysis', label: 'Charts & Analysis', alwaysAvailable: true },
      { path: 'reporting', label: 'Reporting and Exports' },
    ],
    jobStages: ['Reporting and export'],
  },
]

function jobSummaryText(summary: JobStageSummary[], jobStages: string[] | undefined): string | null {
  if (!jobStages || jobStages.length === 0) return null
  const relevant = summary.filter((item) => jobStages.includes(item.stage))
  const total = relevant.reduce((sum, item) => sum + item.total, 0)
  if (total === 0) return null
  const completed = relevant.reduce((sum, item) => sum + item.completed, 0)
  return completed === total
    ? 'All background jobs completed'
    : `${completed}/${total} background jobs completed`
}

const stageColors: Record<string, string> = Object.fromEntries(
  STAGES.map((step) => [step.value, step.color]),
)

function groupColorStyle(group: ProjectSectionGroup): CSSProperties {
  const color = group.color ?? (group.stage ? stageColors[group.stage] : undefined)
  return color ? ({ '--group-color': color } as CSSProperties) : {}
}

export function ProjectPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetail>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  useProjectDocumentTitle(project.data?.name)
  const integrity = useQuery({
    queryKey: ['project-integrity', projectId],
    queryFn: () => apiRequest<WorkflowIntegrityResponse>(
      `/api/v1/projects/${projectId}/integrity`,
    ),
    enabled: Boolean(projectId && project.data?.canManage),
  })
  const jobSummary = useQuery({
    queryKey: ['project-jobs-summary', projectId],
    queryFn: () => apiRequest<JobStageSummary[]>(
      `/api/v1/projects/${projectId}/jobs/summary`,
    ),
    enabled: Boolean(projectId),
    refetchInterval: (query) => (
      (query.state.data ?? []).some((item) => item.active) ? 5000 : false
    ),
  })
  const metadataConflicts = useQuery({
    queryKey: ['metadata-conflicts', projectId],
    queryFn: () => apiRequest<OpenMetadataConflict[]>(
      `/api/v1/projects/${projectId}/metadata-conflicts`,
    ),
    enabled: Boolean(projectId && project.data?.canManage),
  })
  const pdfMatches = useQuery({
    queryKey: ['pdf-matches', projectId, 'project-wide'],
    queryFn: () => apiRequest<{ summary: PdfSummary }>(`/api/v1/projects/${projectId}/pdf-matches`),
    enabled: Boolean(projectId),
  })
  const repair = useMutation({
    mutationFn: () => apiRequest<WorkflowIntegrityRepairResult>(
      `/api/v1/projects/${projectId}/integrity/repair`,
      { method: 'POST' },
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-integrity', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-dashboard', projectId] })
    },
  })
  const pdfMatchSummary = pdfMatches.data?.summary
  const pdfMatchesNeedingReview = pdfMatchSummary
    ? (pdfMatchSummary.ambiguous ?? 0)
      + (pdfMatchSummary.unmatched ?? 0)
      + (pdfMatchSummary.conflict_existing_pdf ?? 0)
    : 0
  if (project.isLoading) return <Page><p>Loading…</p></Page>
  if (!project.data) return <Page><p className="text-danger" role="alert">Project could not be loaded.</p></Page>

  const currentIndex = STAGE_INDEX[project.data.stage] ?? 0

  return (
    <SectionNavigationLayout items={projectMainSections}>
      <Page>
        <p className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-primary">
          Project workspace · {STAGES[currentIndex]?.label ?? project.data.stage}
        </p>
        <h1>{project.data.name}</h1>
        {project.data.archivedAt ? (
          <section className={cn(cardPageSiblingSpacingStyles, 'rounded-md border border-border bg-surface p-4')} data-ui="card" role="status" aria-labelledby="archived-project-heading">
            <h2 id="archived-project-heading">This project is archived</h2>
            <p>
              It is hidden from the project overview and listed under{' '}
              <Link to="/projects?view=archived">Archived projects</Link>.
              {project.data.canManage ? (
                <> Restore it under <Link to={`/projects/${projectId}/admin`}>Project Administration</Link> → Danger Zone.</>
              ) : null}
            </p>
          </section>
        ) : null}
        {integrity.data?.issues.length ? (
          <section className={cn(cardPageSiblingSpacingStyles, 'rounded-md border border-[rgba(255,127,130,0.28)] bg-danger-container p-4 text-danger')} data-ui="card" role="alert" aria-labelledby="workflow-integrity-heading">
            <h2 id="workflow-integrity-heading">Workflow integrity issue</h2>
            <ul>
              {integrity.data.issues.map((issue) => (
                <li key={`${issue.code}-${issue.entityId ?? issue.message}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
            {project.data.canManage ? (
              <>
                <ConfirmButton
                  label="Repair Workflow Integrity"
                  confirmLabel="Repair"
                  warning="This clears stray full-text screening work left over from a reversed decision and backfills any missing extraction/quality work items. This cannot be undone."
                  onConfirm={() => repair.mutate()}
                  disabled={repair.isPending}
                  variant="secondary"
                  icon={<IconRestart />}
                />
                {repair.error ? <p className="text-danger" role="alert">{repair.error.message}</p> : null}
                {repair.isSuccess ? (
                  <p className="text-success" role="status">{repairSummaryText(repair.data)}</p>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
        {metadataConflicts.data?.length ? (
          <section className={cn(cardPageSiblingSpacingStyles, 'rounded-md border border-[rgba(255,127,130,0.28)] bg-danger-container p-4')} data-ui="card" role="status" aria-labelledby="metadata-conflict-heading">
            <h2 id="metadata-conflict-heading">Metadata conflicts need review</h2>
            <p>
              {metadataConflicts.data.length} open metadata conflict{metadataConflicts.data.length === 1 ? '' : 's'} found.{' '}
              <Link to={`/projects/${projectId}/publications?tab=metadata#metadata-conflicts`}>Review metadata conflicts</Link>
            </p>
          </section>
        ) : null}
        {pdfMatchesNeedingReview ? (
          <section className={cn(cardPageSiblingSpacingStyles, 'rounded-md border border-[rgba(255,127,130,0.28)] bg-danger-container p-4')} data-ui="card" role="status" aria-labelledby="pdf-match-heading">
            <h2 id="pdf-match-heading">PDF matches need review</h2>
            <p>
              {pdfMatchesNeedingReview} imported PDF{pdfMatchesNeedingReview === 1 ? '' : 's'} still
              need{pdfMatchesNeedingReview === 1 ? 's' : ''} a publication match.{' '}
              <Link to={`/projects/${projectId}/imports`}>Review PDF matches</Link>
            </p>
          </section>
        ) : null}
        <StageProgress stage={project.data.stage} />
        <ProjectChecklistPanel projectId={projectId} canManage={project.data.canManage} />
      <Card as="section" id="section-project-actions">
        <h2>Actions</h2>
        <InfoBox icon={<IconInfo />}>
          <p>
            Actions unlock review stage by review stage. Once the project reaches a new review stage,
            its actions become available automatically.
          </p>
        </InfoBox>
        <nav aria-label="Project workflow">
          <ol className="m-0 grid list-none gap-5 p-0">
            {projectSectionGroups.map((group, index) => {
            const upcoming = group.stage !== null && STAGE_INDEX[group.stage] > currentIndex
            const visibleLinks = group.links.filter(
              (link) => (
                (!link.managerOnly || project.data.canManage)
                && (!link.validationOnly || project.data.extractionValidationEnabled)
                && (!link.requiresCapability || project.data[link.requiresCapability])
              ),
            )
            if (visibleLinks.length === 0) return null
            const summaryText = jobSummaryText(jobSummary.data ?? [], group.jobStages)
            return (
              <li
                className="grid grid-cols-[56px_minmax(0,1fr)] items-center gap-4"
                data-upcoming={upcoming || undefined}
                key={group.heading}
                style={groupColorStyle(group)}
              >
                <span className={`inline-flex size-14 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--group-color)_18%,transparent)] text-2xl leading-none font-bold text-(--group-color)${upcoming ? ' opacity-45' : ''}`} data-workflow-index={index} aria-hidden="true">{index}</span>
                <div className="min-w-0 border-l-[3px] border-(--group-color) py-1 pl-4">
                  <h3 className={`mb-3 text-base font-bold text-(--group-color)${upcoming ? ' opacity-45' : ''}`}>
                    {group.heading}
                    {summaryText ? (
                      <span className="text-[0.78rem] font-medium text-text-secondary">{'\u00a0·\u00a0'}{summaryText}</span>
                    ) : null}
                  </h3>
                  <div className="flex flex-wrap items-center gap-3">
                    {visibleLinks.map(({ path, label, alwaysAvailable }) => (
                      upcoming && !alwaysAvailable ? (
                        <span
                          key={path}
                          className="inline-flex min-h-[38px] cursor-not-allowed items-center rounded-sm border border-border bg-surface-raised px-[13px] py-2 text-[0.88rem] font-semibold text-text-secondary opacity-[.48]"
                          aria-disabled="true"
                          title="Not available yet — this stage hasn't started."
                        >
                          {label}
                        </span>
                      ) : (
                        <Button as={Link} key={path} variant="secondary" size="sm" to={`/projects/${projectId}/${path}`}>{label}</Button>
                      )
                    ))}
                    {group.stage === 'duplicate_review'
                      && takesDuplicateDecisions(project.data.stage)
                      && project.data.canManage ? (
                        <DuplicateDetectionAction projectId={projectId} compact />
                      ) : null}
                  </div>
                </div>
              </li>
            )
            })}
          </ol>
        </nav>
      </Card>
        <ProjectDashboard projectId={projectId} />
      </Page>
    </SectionNavigationLayout>
  )
}
