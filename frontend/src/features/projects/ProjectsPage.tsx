import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { Button, IconButton } from '../../components/Button'
import { Card } from '../../components/Card'
import { CountPill } from '../../components/CountPill'
import { IconGear, IconPlus, IconSearch } from '../../components/icons'
import { Page } from '../../components/Page'
import { Select } from '../../components/Select'
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
    <Page>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1>Projects</h1>
          <p className="text-text">Manage and monitor all your systematic reviews.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 max-[680px]:w-full">
          <label className="flex h-10 w-[min(18rem,100%)] min-w-0 items-center gap-2 rounded-full border border-border bg-surface px-4 focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--color-focus)] max-[680px]:w-full">
            <span className="sr-only">Search projects</span>
            <span className="size-4 shrink-0 text-text-muted [&_svg]:size-full [&_svg]:fill-current"><IconSearch /></span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 focus:outline-none"
              placeholder="Search projects…"
            />
          </label>
          <Button type="button" startIcon={<IconPlus />} onClick={() => navigate('/projects/new')}>
            New Project
          </Button>
        </div>
      </div>
      {projects.isLoading ? <p>Loading…</p> : null}
      {projects.error ? <p className="text-danger" role="alert">{projects.error.message}</p> : null}
      {projects.data && projects.data.length > 0 ? (
        <section className="my-5 mb-4 flex flex-wrap items-center gap-3 max-[680px]:flex-col max-[680px]:items-stretch" aria-label="Project filters">
          <label>
            <span className="sr-only">Stage</span>
            <Select className="min-w-36 rounded-full bg-surface pl-4 max-[680px]:w-full" value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}>
              <option value="">All Status</option>
              {STAGES.map((stage) => (
                <option key={stage.value} value={stage.value}>{formatStage(stage.value)}</option>
              ))}
            </Select>
          </label>
          <label>
            <span className="sr-only">My role</span>
            <Select className="min-w-36 rounded-full bg-surface pl-4 max-[680px]:w-full" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
              <option value="">All Roles</option>
              {Object.entries(roleLabels)
                .filter(([value]) => value !== 'administrator')
                .map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
            </Select>
          </label>
          <label>
            <span className="sr-only">Project type</span>
            <Select className="min-w-36 rounded-full bg-surface pl-4 max-[680px]:w-full" value={reviewTypeFilter} onChange={(event) => setReviewTypeFilter(event.target.value)}>
              <option value="">All Types</option>
              {Object.entries(reviewTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </label>
          <label>
            <span className="sr-only">Project owner</span>
            <Select className="min-w-36 rounded-full bg-surface pl-4 max-[680px]:w-full" value={ownerFilter} onChange={(event) => setOwnerFilter(event.target.value)}>
              <option value="">All Owners</option>
              {owners.map(([id, displayName]) => (
                <option key={id} value={id}>{displayName}</option>
              ))}
            </Select>
          </label>
          <Button className="max-[680px]:w-full" type="button" variant="secondary" disabled={!hasFilters} onClick={clearFilters}>
            Clear filters
          </Button>
        </section>
      ) : null}
      {projects.data ? (
        <CountPill count={hasFilters ? filteredProjects.length : projects.data.length}>
          {hasFilters ? `of ${projects.data.length} projects` : `project${projects.data.length === 1 ? '' : 's'}`}
        </CountPill>
      ) : null}
      {projects.data?.length === 0 ? (
        <p className="text-text">No projects yet. Create your first project to get started.</p>
      ) : null}
      {projects.data && projects.data.length > 0 && filteredProjects.length === 0 ? (
        <p className="text-text">No projects match your filters.</p>
      ) : null}
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4 p-0" aria-label="Projects">
        {filteredProjects.map((project) => (
          <Card as="li" key={project.id} className="flex flex-col">
            <div className="flex items-start justify-between gap-3">
              <span className="inline-flex min-h-[26px] items-center rounded-full border border-[color-mix(in_srgb,var(--stage-color,var(--color-primary))_35%,transparent)] bg-[color-mix(in_srgb,var(--stage-color,var(--color-primary))_14%,transparent)] px-2.5 py-[3px] text-[0.78rem] font-bold text-(--stage-color)" data-project-stage={project.stage} style={stageBadgeStyle(project.stage)}>
                {formatStage(project.stage)}
              </span>
            </div>
            <h2 className="mt-4"><Link to={`/projects/${project.id}`}>{project.name}</Link></h2>
            {project.description ? <p className="mt-1 text-text-muted">{project.description}</p> : null}
            <div className="flex flex-wrap gap-2">
              {projectPills(project).map((pill) => (
                <Badge
                  key={pill.text}
                  variant={pill.variant === 'warning' ? 'warning' : 'neutral'}
                  className="min-h-6 border border-border px-2.5 text-[0.76rem]"
                >
                  {pill.text}
                </Badge>
              ))}
            </div>
            <ProjectProgressDots stage={project.stage} />
            <dl className="m-0 grid grid-cols-4 gap-2 border-y border-border py-4 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-0.5 [&>div]:text-center [&_dd]:m-0 [&_dd]:text-[1.15rem] [&_dd]:font-bold [&_dd]:text-text [&_dt]:truncate [&_dt]:text-[0.74rem] [&_dt]:text-text-muted">
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
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[0.82rem] text-text-muted">
                Updated <time dateTime={project.updatedAt}>{formatRelativeTime(project.updatedAt)}</time>
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <Button as={Link} variant="secondary" to={`/projects/${project.id}`}>Open Project</Button>
                {project.myRole !== 'reviewer' ? (
                  <IconButton
                    as={Link}
                    variant="secondary"
                    to={`/projects/${project.id}/admin`}
                    aria-label={`Manage ${project.name}`}
                  >
                    <IconGear />
                  </IconButton>
                ) : null}
              </div>
            </div>
          </Card>
        ))}
        {projects.data && projects.data.length > 0 ? (
          <Card as="li" className="flex flex-col items-center justify-center border-dashed bg-surface text-center">
            <IconButton type="button" className="size-12 min-h-12 min-w-12 rounded-full [&_svg]:size-[22px]" onClick={() => navigate('/projects/new')}>
              <IconPlus />
            </IconButton>
            <h2>Create New Project</h2>
            <p className="text-text">Start a new review project</p>
            <Button type="button" onClick={() => navigate('/projects/new')}>Get Started</Button>
          </Card>
        ) : null}
      </ul>
    </Page>
  )
}
