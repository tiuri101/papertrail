import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { SectionNavigationLayout } from '../../components/SectionNavigationLayout'
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
  },
  {
    heading: 'Deduplication',
    stage: 'duplicate_review',
    links: [{ path: 'duplicates', label: 'Duplicate Review' }],
  },
  {
    heading: 'Title/Abstract Screening',
    stage: 'title_abstract_screening',
    links: [
      { path: 'screening/title_abstract', label: 'Title/Abstract Screening' },
      { path: 'screening/title_abstract/my-decisions', label: 'My Title/Abstract Decisions' },
      { path: 'conflicts/title_abstract', label: 'Title/Abstract Conflicts', managerOnly: true },
    ],
  },
  {
    heading: 'Full-Text',
    stage: 'full_text_screening',
    links: [
      { path: 'full-text', label: 'Full-Text' },
      { path: 'screening/full_text/my-decisions', label: 'My Full-Text Decisions' },
      { path: 'conflicts/full_text', label: 'Full-Text Conflicts', managerOnly: true },
    ],
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
  },
  {
    heading: 'Final Results',
    stage: 'completed',
    links: [
      { path: 'results', label: 'Final Results' },
      { path: 'analysis', label: 'Charts and Analysis' },
    ],
  },
  {
    heading: 'Reporting',
    stage: null,
    links: [{ path: 'reporting', label: 'Reporting and Exports' }],
  },
]

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
  if (project.isLoading) return <main className="page"><p>Loading…</p></main>
  if (!project.data) return <main className="page"><p className="error" role="alert">Project could not be loaded.</p></main>

  const currentIndex = STAGE_INDEX[project.data.stage] ?? 0

  return (
    <SectionNavigationLayout items={projectMainSections}>
      <main className="page">
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
            return (
              <div
                className={upcoming ? 'nav-group nav-group--upcoming' : 'nav-group'}
                key={group.heading}
                style={groupColorStyle(group.stage)}
              >
                <h3>{group.heading}</h3>
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
