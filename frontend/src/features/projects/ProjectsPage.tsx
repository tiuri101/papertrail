import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { apiRequest } from '../../api/client'

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
  duplicate_review: 'Duplicate review',
  title_abstract_screening: 'Title & abstract screening',
  full_text_screening: 'Full-text screening',
  extraction_quality: 'Extraction & quality assessment',
  completed: 'Completed',
}

function formatReviewType(reviewType: string) {
  return reviewTypeLabels[reviewType] ?? reviewType
}

function formatStage(stage: string) {
  return stageLabels[stage] ?? stage
}

export function ProjectsPage() {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [reviewType, setReviewType] = useState('systematic_review')
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiRequest<Project[]>('/api/v1/projects'),
  })
  const create = useMutation({
    mutationFn: () => apiRequest<Project>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name, reviewType }),
    }),
    onSuccess: () => {
      setName('')
      setShowForm(false)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
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
              <span className="stage-badge">{formatStage(project.stage)}</span>
              {' '}
              <span className="muted">{formatReviewType(project.reviewType)}</span>
            </p>
          </li>
        ))}
      </ul>
      {showForm ? (
        <section className="card">
          <h2>Create project</h2>
          <form onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
            <label>
              Project name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label>
              Review type
              <select
                value={reviewType}
                onChange={(event) => setReviewType(event.target.value)}
              >
                <option value="systematic_review">Systematic review</option>
                <option value="scoping_review">Scoping review</option>
                <option value="systematic_mapping">Systematic mapping study</option>
                <option value="other">Other</option>
              </select>
            </label>
            <button type="submit" disabled={create.isPending}>Create</button>
            <button type="button" onClick={() => setShowForm(false)}>Cancel</button>
          </form>
          {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
        </section>
      ) : (
        <button type="button" onClick={() => setShowForm(true)}>New project</button>
      )}
    </main>
  )
}
