import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CountPill } from '../../components/CountPill'
import { IconGear, IconPlus, IconSearch } from '../../components/icons'
import { ProjectProgressDots, STAGES } from './StageProgress'

interface Project {
  id: string
  name: string
  description: string | null
  reviewType: string
  stage: string
  createdAt: string
  updatedAt: string
  owner: { id: string; displayName: string } | null
  myRole: ProjectRole
  openTaskCount: number
  primaryLabel: string
  primaryCount: number
  secondaryLabel: string
  secondaryCount: number
  reviewerCount: number
  percentComplete: number
}

type ProjectRole = 'owner' | 'administrator' | 'reviewer'

const reviewTypeLabels: Record<string, string> = {
  systematic_review: 'Systematic review',
  scoping_review: 'Scoping review',
  systematic_mapping: 'Systematic mapping study',
  other: 'Other',
}

const stageLabels: Record<string, string> = {
  draft: 'Draft',
  duplicate_review: 'Duplicate Review',
  title_abstract_screening: 'Title/Abstract Screening',
  full_text_screening: 'Full-Text Screening',
  extraction_quality: 'Extraction & Quality',
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

function formatStage(stage: string) {
  return stageLabels[stage] ?? stage
}

function formatCreatedAt(createdAt: string) {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? createdAt : projectDateFormatter.format(date)
}

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
]

function formatRelativeTime(isoDate: string) {
  const date = new Date(isoDate)
  if (Number.isNaN(date.getTime())) return isoDate
  const elapsedSeconds = (date.getTime() - Date.now()) / 1000
  for (const [unit, secondsInUnit] of RELATIVE_UNITS) {
    if (Math.abs(elapsedSeconds) >= secondsInUnit) {
      return relativeTimeFormatter.format(Math.round(elapsedSeconds / secondsInUnit), unit)
    }
  }
  return relativeTimeFormatter.format(Math.round(elapsedSeconds / 60), 'minute')
}

function stageBadgeStyle(stage: string): CSSProperties {
  const color = STAGES.find((step) => step.value === stage)?.color
  return color ? ({ '--stage-color': color } as CSSProperties) : {}
}

interface ProjectPill {
  text: string
  variant?: 'warning'
}

function projectPills(project: Project): ProjectPill[] {
  const pills: ProjectPill[] = [
    { text: formatReviewType(project.reviewType) },
    { text: roleLabels[project.myRole] },
  ]
  if (project.owner && project.myRole !== 'owner') pills.push({ text: `Owner: ${project.owner.displayName}` })
  pills.push({ text: `Created ${formatCreatedAt(project.createdAt)}` })
  if (project.openTaskCount > 0) {
    pills.push({
      text: `${project.openTaskCount} open ${project.openTaskCount === 1 ? 'task' : 'tasks'}`,
      variant: 'warning',
    })
  }
  return pills
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
    <main className="page projects-page">
      <div className="projects-page__header">
        <div>
          <h1>Projects</h1>
          <p className="muted">Manage and monitor all your systematic reviews.</p>
        </div>
        <div className="projects-page__header-actions">
          <label className="projects-page__search">
            <span className="visually-hidden">Search projects</span>
            <IconSearch />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search projects…"
            />
          </label>
          <button type="button" onClick={() => navigate('/projects/new')}>
            <IconPlus />
            New Project
          </button>
        </div>
      </div>
      {projects.isLoading ? <p>Loading…</p> : null}
      {projects.error ? <p className="error" role="alert">{projects.error.message}</p> : null}
      {projects.data && projects.data.length > 0 ? (
        <section className="project-filters" aria-label="Project filters">
          <label>
            <span className="visually-hidden">Stage</span>
            <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}>
              <option value="">All Status</option>
              {STAGES.map((stage) => (
                <option key={stage.value} value={stage.value}>{formatStage(stage.value)}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">My role</span>
            <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
              <option value="">All Roles</option>
              {Object.entries(roleLabels)
                .filter(([value]) => value !== 'administrator')
                .map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">Project type</span>
            <select value={reviewTypeFilter} onChange={(event) => setReviewTypeFilter(event.target.value)}>
              <option value="">All Types</option>
              {Object.entries(reviewTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">Project owner</span>
            <select value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
              <option value="">All Owners</option>
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
        <CountPill count={hasFilters ? filteredProjects.length : projects.data.length}>
          {hasFilters ? `of ${projects.data.length} projects` : `project${projects.data.length === 1 ? '' : 's'}`}
        </CountPill>
      ) : null}
      {projects.data?.length === 0 ? (
        <p className="muted">No projects yet. Create your first project to get started.</p>
      ) : null}
      {projects.data && projects.data.length > 0 && filteredProjects.length === 0 ? (
        <p className="muted">No projects match your filters.</p>
      ) : null}
      <ul className="card-list project-card-grid" aria-label="Projects">
        {filteredProjects.map((project) => (
          <li key={project.id} className="card project-card">
            <div className="project-card__top">
              <span className="stage-badge" style={stageBadgeStyle(project.stage)}>
                {formatStage(project.stage)}
              </span>
            </div>
            <h2><Link to={`/projects/${project.id}`}>{project.name}</Link></h2>
            {project.description ? <p className="muted project-card__description">{project.description}</p> : null}
            <div className="project-card__pills">
              {projectPills(project).map((pill) => (
                <span
                  key={pill.text}
                  className={pill.variant ? `pill pill--${pill.variant}` : 'pill'}
                >
                  {pill.text}
                </span>
              ))}
            </div>
            <ProjectProgressDots stage={project.stage} />
            <dl className="project-card__stats">
              <div>
                <dd>{project.primaryCount}</dd>
                <dt>{project.primaryLabel}</dt>
              </div>
              <div>
                <dd>{project.secondaryCount}</dd>
                <dt>{project.secondaryLabel}</dt>
              </div>
              <div>
                <dd>{project.reviewerCount}</dd>
                <dt>Reviewers</dt>
              </div>
              <div>
                <dd>{project.percentComplete}%</dd>
                <dt>Complete</dt>
              </div>
            </dl>
            <div className="project-card__footer">
              <span className="muted project-card__updated">
                Updated <time dateTime={project.updatedAt}>{formatRelativeTime(project.updatedAt)}</time>
              </span>
              <div className="project-card__actions">
                <Link className="button-secondary" to={`/projects/${project.id}`}>Open Project</Link>
                {project.myRole !== 'reviewer' ? (
                  <Link
                    className="project-card__menu"
                    to={`/projects/${project.id}/admin`}
                    aria-label={`Manage ${project.name}`}
                  >
                    <IconGear />
                  </Link>
                ) : null}
              </div>
            </div>
          </li>
        ))}
        {projects.data && projects.data.length > 0 ? (
          <li className="card project-card project-card--create">
            <button type="button" className="project-card__create-icon" onClick={() => navigate('/projects/new')}>
              <IconPlus />
            </button>
            <h2>Create New Project</h2>
            <p className="muted">Start a new systematic review</p>
            <button type="button" onClick={() => navigate('/projects/new')}>Get Started</button>
          </li>
        ) : null}
      </ul>
    </main>
  )
}
