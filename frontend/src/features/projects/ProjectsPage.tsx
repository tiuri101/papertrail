import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { STAGES } from './StageProgress'

interface Project {
  id: string
  name: string
  description: string | null
  reviewType: string
  stage: string
}

const reviewTypeLabels: Record<string, string> = {
  systematic_review: 'Systematic review',
  scoping_review: 'Scoping review',
  systematic_mapping: 'Systematic mapping study',
  other: 'Other',
}

const stageLabels: Record<string, string> = {
  draft: 'Draft',
  duplicate_review: 'Duplicate Review',
  title_abstract_screening: 'Title & Abstract Screening',
  full_text_screening: 'Full-Text Screening',
  extraction_quality: 'Extraction & Quality Assessment',
  completed: 'Completed',
}

function formatReviewType(reviewType: string) {
  return reviewTypeLabels[reviewType] ?? reviewType
}

function formatStage(stage: string) {
  return stageLabels[stage] ?? stage
}

const stageColors: Record<string, string> = Object.fromEntries(
  STAGES.map((step) => [step.value, step.color]),
)

function stageBadgeStyle(stage: string): CSSProperties {
  const color = stageColors[stage]
  return color ? ({ '--stage-color': color } as CSSProperties) : {}
}

export function ProjectsPage() {
  const navigate = useNavigate()
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiRequest<Project[]>('/api/v1/projects'),
  })

  return (
    <main className="page">
      <h1>Projects</h1>
      {projects.isLoading ? <p>Loading…</p> : null}
      {projects.error ? <p className="error" role="alert">{projects.error.message}</p> : null}
      {projects.data ? (
        <p className="muted">{projects.data.length} project{projects.data.length === 1 ? '' : 's'}</p>
      ) : null}
      {projects.data?.length === 0 ? (
        <p className="muted">No projects yet. Create your first project to get started.</p>
      ) : null}
      <ul className="card-list">
        {projects.data?.map((project) => (
          <li key={project.id} className="card">
            <h2><Link to={`/projects/${project.id}`}>{project.name}</Link></h2>
            {project.description ? <p className="muted">{project.description}</p> : null}
            <p>
              <span className="stage-badge" style={stageBadgeStyle(project.stage)}>
                {formatStage(project.stage)}
              </span>
              {' '}
              <span className="muted">{formatReviewType(project.reviewType)}</span>
            </p>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => navigate('/projects/new')}>New Project</button>
    </main>
  )
}
