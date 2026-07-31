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
}

const STAGE_INDEX: Record<string, number> = {
  draft: 0,
  duplicate_review: 1,
  title_abstract_screening: 2,
  full_text_screening: 3,
  extraction_quality: 4,
  completed: 5,
}

interface ProjectSectionGroup {
  heading: string
  stage: string | null
  links: Array<[string, string]>
}

const projectSectionGroups: ProjectSectionGroup[] = [
  {
    heading: 'Setup & Configuration',
    stage: null,
    links: [
      ['admin', 'Administration'],
      ['research-agenda', 'Research Agenda'],
      ['forms', 'Forms and Templates'],
      ['jobs', 'Jobs'],
    ],
  },
  {
    heading: 'Searches & Publications',
    stage: null,
    links: [
      ['imports', 'Searches and Imports'],
      ['publications', 'Publications'],
    ],
  },
  {
    heading: 'Deduplication',
    stage: 'duplicate_review',
    links: [['duplicates', 'Duplicate Review']],
  },
  {
    heading: 'Title/Abstract Screening',
    stage: 'title_abstract_screening',
    links: [
      ['screening/title_abstract', 'Title/Abstract Screening'],
      ['screening/title_abstract/my-decisions', 'My Title/Abstract Decisions'],
      ['conflicts/title_abstract', 'Title/Abstract Conflicts'],
    ],
  },
  {
    heading: 'Full-Text',
    stage: 'full_text_screening',
    links: [
      ['full-text', 'Full-Text'],
      ['screening/full_text/my-decisions', 'My Full-Text Decisions'],
      ['conflicts/full_text', 'Full-Text Conflicts'],
    ],
  },
  {
    heading: 'Extraction & Quality',
    stage: 'extraction_quality',
    links: [
      ['extraction', 'Data Extraction'],
      ['quality', 'Quality Assessment'],
    ],
  },
  {
    heading: 'Reporting',
    stage: null,
    links: [['reporting', 'Reporting and Exports']],
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
            return (
              <div className={upcoming ? 'nav-group nav-group--upcoming' : 'nav-group'} key={group.heading}>
                <h3>{group.heading}</h3>
                <div className="toolbar">
                  {group.links.map(([path, label]) => (
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
