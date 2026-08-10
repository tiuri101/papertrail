import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { SectionNavigationLayout } from '../../components/SectionNavigationLayout'
import { ProjectDashboard } from '../administration/ProjectDashboard'
import { DuplicateDetectionAction } from '../duplicates/DuplicateDetectionAction'
import { type PdfSummary } from '../imports/PdfMatchReview'
import { ProjectChecklistPanel } from './ProjectChecklistPanel'
import { STAGES, StageProgress } from './StageProgress'
import { useProjectDocumentTitle } from './useProjectDocumentTitle'

interface ProjectDetail {
  id: string
  name: string
  stage: string
  canManage: boolean
  extractionValidationEnabled: boolean
  canTitleAbstractScreen: boolean
  canFullTextScreen: boolean
  canExtract: boolean
  canAssessQuality: boolean
}

interface WorkflowIntegrityIssue {
  code: string
  entityId?: string
  message: string
}

interface WorkflowIntegrityResponse {
  issues: WorkflowIntegrityIssue[]
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

interface ProjectSectionLink {
  path: string
  label: string
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
    links: [{ path: 'duplicates', label: 'Review Duplicate Candidates' }],
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
      { path: 'analysis', label: 'Charts and Analysis' },
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
  const pdfMatchSummary = pdfMatches.data?.summary
  const pdfMatchesNeedingReview = pdfMatchSummary
    ? (pdfMatchSummary.ambiguous ?? 0)
      + (pdfMatchSummary.unmatched ?? 0)
      + (pdfMatchSummary.conflict_existing_pdf ?? 0)
    : 0
  if (project.isLoading) return <main className="page"><p>Loading…</p></main>
  if (!project.data) return <main className="page"><p className="error" role="alert">Project could not be loaded.</p></main>

  const currentIndex = STAGE_INDEX[project.data.stage] ?? 0

  return (
    <SectionNavigationLayout items={projectMainSections}>
      <main className="page">
        <p className="eyebrow">
          Project workspace · {STAGES[currentIndex]?.label ?? project.data.stage}
        </p>
        <h1>{project.data.name}</h1>
        {integrity.data?.issues.length ? (
          <section className="error alert" role="alert" aria-labelledby="workflow-integrity-heading">
            <h2 id="workflow-integrity-heading">Workflow integrity issue</h2>
            <ul>
              {integrity.data.issues.map((issue) => (
                <li key={`${issue.code}-${issue.entityId ?? issue.message}`}>
                  {issue.message}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {metadataConflicts.data?.length ? (
          <section className="alert" role="status" aria-labelledby="metadata-conflict-heading">
            <h2 id="metadata-conflict-heading">Metadata conflicts need review</h2>
            <p>
              {metadataConflicts.data.length} open metadata conflict{metadataConflicts.data.length === 1 ? '' : 's'} found.{' '}
              <Link to={`/projects/${projectId}/publications`}>Review metadata conflicts</Link>
            </p>
          </section>
        ) : null}
        {pdfMatchesNeedingReview ? (
          <section className="alert" role="status" aria-labelledby="pdf-match-heading">
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
      <section id="section-project-actions" className="card">
        <h2>Actions</h2>
        <nav aria-label="Project workflow">
          <ol className="workflow-nav">
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
                className={upcoming ? 'nav-group nav-group--upcoming' : 'nav-group'}
                key={group.heading}
                style={groupColorStyle(group)}
              >
                <span className="workflow-nav__number" aria-hidden="true">{index}</span>
                <div className="workflow-nav__body">
                  <h3>
                    {group.heading}
                    {summaryText ? (
                      <span className="job-stage-summary">{'\u00a0·\u00a0'}{summaryText}</span>
                    ) : null}
                  </h3>
                  <div className="toolbar">
                    {visibleLinks.map(({ path, label }) => (
                      upcoming ? (
                        <span
                          key={path}
                          className="nav-link-disabled"
                          aria-disabled="true"
                          title="Not available yet — this stage hasn't started."
                        >
                          {label}
                        </span>
                      ) : (
                        <Link key={path} to={`/projects/${projectId}/${path}`}>{label}</Link>
                      )
                    ))}
                    {group.stage === 'duplicate_review'
                      && project.data.stage === 'duplicate_review'
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
      </section>
        <ProjectDashboard projectId={projectId} />
      </main>
    </SectionNavigationLayout>
  )
}
