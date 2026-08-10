import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { IconPlus } from '../../components/icons'
import { STAGES } from './StageProgress'

interface Project {
  id: string
  name: string
  description: string | null
  reviewType: string
  stage: string
  createdAt: string
  owner: { id: string; displayName: string } | null
  myRole: ProjectRole
  openTaskCount: number
}

type ProjectRole = 'owner' | 'administrator' | 'reviewer'

const reviewTypeLabels: Record<string, string> = {
  systematic_review: 'Systematic review',
  scoping_review: 'Scoping review',
  systematic_mapping: 'Systematic mapping study',
  other: 'Other',
}

const reviewTypeClasses: Record<string, string> = {
  systematic_review: 'review-type-badge--systematic-review',
  scoping_review: 'review-type-badge--scoping-review',
  systematic_mapping: 'review-type-badge--systematic-mapping',
  other: 'review-type-badge--other',
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

const roleLabels: Record<ProjectRole, string> = {
  owner: 'Owner',
  administrator: 'Administrator',
  reviewer: 'Reviewer',
}

const projectDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

function reviewTypeClass(reviewType: string) {
  return reviewTypeClasses[reviewType] ?? reviewTypeClasses.other
}

function formatStage(stage: string) {
  return stageLabels[stage] ?? stage
}

function formatCreatedAt(createdAt: string) {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? createdAt : projectDateFormatter.format(date)
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
  const [search, setSearch] = useState('')
  const [reviewTypeFilter, setReviewTypeFilter] = useState('')
  const [stageFilter, setStageFilter] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiRequest<Project[]>('/api/v1/projects'),
  })
  const owners = useMemo(() => {
    const uniqueOwners = new Map<string, string>()
    for (const project of projects.data ?? []) {
      if (project.owner) uniqueOwners.set(project.owner.id, project.owner.displayName)
    }
    return [...uniqueOwners.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [projects.data])
  const filteredProjects = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase()
    return (projects.data ?? []).filter((project) => {
      const searchableText = [project.name, project.description, project.owner?.displayName]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
      return (!normalizedSearch || searchableText.includes(normalizedSearch))
        && (!reviewTypeFilter || project.reviewType === reviewTypeFilter)
        && (!stageFilter || project.stage === stageFilter)
        && (!roleFilter || project.myRole === roleFilter)
        && (!ownerFilter || project.owner?.id === ownerFilter)
    })
  }, [ownerFilter, projects.data, reviewTypeFilter, roleFilter, search, stageFilter])
  const hasFilters = Boolean(search || reviewTypeFilter || stageFilter || roleFilter || ownerFilter)

  function clearFilters() {
    setSearch('')
    setReviewTypeFilter('')
    setStageFilter('')
    setRoleFilter('')
    setOwnerFilter('')
  }

  return (
    <main className="page">
      <h1>Projects</h1>
      {projects.isLoading ? <p>Loading…</p> : null}
      {projects.error ? <p className="error" role="alert">{projects.error.message}</p> : null}
      {projects.data && projects.data.length > 0 ? (
        <section className="project-filters" aria-label="Project filters">
          <label className="project-filters__search">
            Search projects
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, description, or owner"
            />
          </label>
          <label>
            Project type
            <select value={reviewTypeFilter} onChange={(event) => setReviewTypeFilter(event.target.value)}>
              <option value="">All types</option>
              {Object.entries(reviewTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Stage
            <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}>
              <option value="">All stages</option>
              {STAGES.map((stage) => (
                <option key={stage.value} value={stage.value}>{formatStage(stage.value)}</option>
              ))}
            </select>
          </label>
          <label>
            My role
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
              <option value="">All roles</option>
              {Object.entries(roleLabels)
                .filter(([value]) => value !== 'administrator')
                .map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
            </select>
          </label>
          <label>
            Project owner
            <select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
              <option value="">All owners</option>
              {owners.map(([id, displayName]) => (
                <option key={id} value={id}>{displayName}</option>
              ))}
            </select>
          </label>
          <button type="button" className="button-secondary" disabled={!hasFilters} onClick={clearFilters}>
            Clear filters
          </button>
        </section>
      ) : null}
      {projects.data ? (
        <p className="muted">
          {hasFilters ? `${filteredProjects.length} of ` : ''}
          {projects.data.length} project{projects.data.length === 1 ? '' : 's'}
        </p>
      ) : null}
      {projects.data?.length === 0 ? (
        <p className="muted">No projects yet. Create your first project to get started.</p>
      ) : null}
      {projects.data && projects.data.length > 0 && filteredProjects.length === 0 ? (
        <p className="muted">No projects match your filters.</p>
      ) : null}
      <ul className="card-list">
        {filteredProjects.map((project) => (
          <li key={project.id} className="card">
            <h2><Link to={`/projects/${project.id}`}>{project.name}</Link></h2>
            <p className="project-card__badges">
              <span className="stage-badge" style={stageBadgeStyle(project.stage)}>
                {formatStage(project.stage)}
              </span>
              {' '}
              <span className={`review-type-badge ${reviewTypeClass(project.reviewType)}`}>
                {formatReviewType(project.reviewType)}
              </span>
              <span className={`project-role-badge project-role-badge--${project.myRole}`}>
                {roleLabels[project.myRole]}
              </span>
            </p>
            {project.description ? <p className="muted">{project.description}</p> : null}
            <dl className="project-card__details">
              <div>
                <dt>My tasks</dt>
                <dd>
                  <span className={`project-task-badge ${project.openTaskCount > 0 ? 'project-task-badge--open' : 'project-task-badge--clear'}`}>
                    {project.openTaskCount > 0
                      ? `${project.openTaskCount} open ${project.openTaskCount === 1 ? 'task' : 'tasks'}`
                      : 'No open tasks'}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd><time dateTime={project.createdAt}>{formatCreatedAt(project.createdAt)}</time></dd>
              </div>
              <div>
                <dt>Project owner</dt>
                <dd>{project.owner?.displayName ?? 'Not assigned'}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => navigate('/projects/new')}>
        <IconPlus />
        New Project
      </button>
    </main>
  )
}
