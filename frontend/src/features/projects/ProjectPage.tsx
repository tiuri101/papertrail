import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ProjectDashboard } from '../administration/ProjectDashboard'
import { ProjectChecklistPanel } from './ProjectChecklistPanel'
import { StageProgress } from './StageProgress'

interface ProjectDetail {
  id: string
  name: string
  stage: string
  canManage: boolean
}

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
    ],
  },
  {
    heading: 'Deduplication',
    stage: 'duplicate_review',
    links: [{ path: 'duplicates', label: 'Duplicate Review', managerOnly: true }],
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
      { path: 'quality', label: 'Quality Assessment' },
    ],
  },
  {
    heading: 'Final Results',
    stage: 'completed',
    links: [{ path: 'results', label: 'Final Results' }],
  },
  {
    heading: 'Reporting',
    stage: null,
    links: [{ path: 'reporting', label: 'Reporting and Exports' }],
  },
]

export function ProjectPage() {
  const { projectId = '' } = useParams()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetail>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  if (project.isLoading) return <main className="page"><p>Loading…</p></main>
  if (!project.data) return <main className="page"><p className="error" role="alert">Project could not be loaded.</p></main>

  const currentIndex = STAGE_INDEX[project.data.stage] ?? 0

  return (
    <main className="page">
      <h1>{project.data.name}</h1>
      <StageProgress stage={project.data.stage} />
      <ProjectChecklistPanel projectId={projectId} />
      <section className="card">
        <h2>Actions</h2>
        <nav className="workflow-nav" aria-label="Project workflow">
          {projectSectionGroups.map((group) => {
            const upcoming = group.stage !== null && STAGE_INDEX[group.stage] > currentIndex
            const visibleLinks = group.links.filter(
              (link) => !link.managerOnly || project.data.canManage,
            )
            if (visibleLinks.length === 0) return null
            return (
              <div className={upcoming ? 'nav-group nav-group--upcoming' : 'nav-group'} key={group.heading}>
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
  )
}
