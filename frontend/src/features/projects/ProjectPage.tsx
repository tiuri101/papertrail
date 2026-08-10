import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { SectionNavigationLayout } from '../../components/SectionNavigationLayout'
import { Tooltip } from '../../components/Tooltip'
import { ProjectDashboard } from '../administration/ProjectDashboard'
import { ProjectChecklistPanel } from './ProjectChecklistPanel'
import { STAGES, StageProgress } from './StageProgress'

interface ProjectDetail {
  id: string
  name: string
  stage: string
  canManage: boolean
  extractionValidationEnabled: boolean
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

interface ProjectSectionLink {
  path: string
  label: string
  managerOnly?: boolean
  validationOnly?: boolean
}

interface ProjectSectionGroup {
  heading: string
  stage: string | null
  links: ProjectSectionLink[]
  jobStages?: string[]
}

const projectSectionGroups: ProjectSectionGroup[] = [
  {
    heading: 'Setup & Configuration',
    stage: null,
    links: [
      { path: 'admin', label: 'Administration', managerOnly: true },
      { path: 'setup', label: 'Setup Wizard', managerOnly: true },
      { path: 'research-agenda', label: 'Research Agenda' },
      { path: 'forms', label: 'Forms and Templates', managerOnly: true },
      { path: 'jobs', label: 'Jobs' },
    ],
  },
  {
    heading: 'Searches & Publications',
    stage: null,
    links: [
      { path: 'imports', label: 'Searches and Imports' },
      { path: 'publications', label: 'Publications' },
      { path: 'publications/add', label: 'Add a Publication' },
    ],
    jobStages: ['Publication import', 'Publication metadata'],
  },
  {
    heading: 'Deduplication',
    stage: 'duplicate_review',
    links: [{ path: 'duplicates', label: 'Duplicate Review' }],
    jobStages: ['Duplicate review'],
  },
  {
    heading: 'Title/Abstract Screening',
    stage: 'title_abstract_screening',
    links: [
      { path: 'screening/title_abstract', label: 'Title/Abstract Screening' },
      { path: 'screening/title_abstract/my-decisions', label: 'My Title/Abstract Decisions' },
      { path: 'conflicts/title_abstract', label: 'Title/Abstract Conflicts', managerOnly: true },
    ],
    jobStages: ['Title/abstract screening'],
  },
  {
    heading: 'Full-Text',
    stage: 'full_text_screening',
    links: [
      { path: 'full-text', label: 'Full-Text' },
      { path: 'screening/full_text/my-decisions', label: 'My Full-Text Decisions' },
      { path: 'conflicts/full_text', label: 'Full-Text Conflicts', managerOnly: true },
    ],
    jobStages: ['Full-text preparation', 'Full-text screening'],
  },
  {
    heading: 'Extraction & Quality',
    stage: 'extraction_quality',
    links: [
      { path: 'extraction', label: 'Data Extraction' },
      { path: 'extraction/mine', label: 'My Submitted Extractions' },
      {
        path: 'extraction/validation',
        label: 'Review LLM Extraction Validation',
        validationOnly: true,
      },
      { path: 'quality', label: 'Quality Assessment' },
      { path: 'quality/mine', label: 'My Submitted Quality Assessments' },
    ],
    jobStages: ['Data extraction', 'Extraction validation'],
  },
  {
    heading: 'Final Results',
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

function groupColorStyle(stage: string | null): CSSProperties {
  const color = stage ? stageColors[stage] : undefined
  return color ? ({ '--group-color': color } as CSSProperties) : {}
}

export function ProjectPage() {
  const { projectId = '' } = useParams()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetail>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
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
        <StageProgress stage={project.data.stage} />
        <ProjectChecklistPanel projectId={projectId} canManage={project.data.canManage} />
      <section id="section-project-actions" className="card">
        <h2>Actions</h2>
        <nav className="workflow-nav" aria-label="Project workflow">
          {projectSectionGroups.map((group) => {
            const upcoming = group.stage !== null && STAGE_INDEX[group.stage] > currentIndex
            const visibleLinks = group.links.filter(
              (link) => (
                (!link.managerOnly || project.data.canManage)
                && (!link.validationOnly || project.data.extractionValidationEnabled)
              ),
            )
            if (visibleLinks.length === 0) return null
            const summaryText = jobSummaryText(jobSummary.data ?? [], group.jobStages)
            return (
              <div
                className={upcoming ? 'nav-group nav-group--upcoming' : 'nav-group'}
                key={group.heading}
                style={groupColorStyle(group.stage)}
              >
                <h3>
                  {group.heading}
                  {summaryText ? (
                    <Tooltip text="Background jobs are automated tasks (like importing files or checking for duplicates) that run behind the scenes. This shows how many have finished for this stage.">
                      <span className="job-stage-summary"> · {summaryText}</span>
                    </Tooltip>
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
                </div>
              </div>
            )
          })}
        </nav>
      </section>
        <ProjectDashboard projectId={projectId} />
      </main>
    </SectionNavigationLayout>
  )
}
