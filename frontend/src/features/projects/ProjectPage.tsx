import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface ProjectDetail {
  id: string
  name: string
  stage: string
  researchQuestions: Array<{ id: string; text: string }>
  criteria: Array<{ id: string; kind: string; text: string }>
}

const projectSections = [
  ['admin', 'Administration'],
  ['imports', 'Searches and imports'],
  ['publications', 'Publications'],
  ['duplicates', 'Duplicate review'],
  ['screening/title_abstract', 'Title/abstract screening'],
  ['conflicts/title_abstract', 'Title/abstract conflicts'],
  ['full-text', 'Full-text retrieval'],
  ['screening/full_text', 'Full-text screening'],
  ['conflicts/full_text', 'Full-text conflicts'],
  ['forms', 'Forms and templates'],
  ['extraction', 'Data extraction'],
  ['quality', 'Quality assessment'],
  ['reporting', 'Reporting and exports'],
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
  return (
    <main className="page">
      <h1>{project.data.name}</h1>
      <p>Stage: <strong>{project.data.stage}</strong></p>
      <nav className="toolbar" aria-label="Project workflow">
        {projectSections.map(([path, label]) => <Link key={path} to={`/projects/${projectId}/${path}`}>{label}</Link>)}
      </nav>
      <section className="card">
        <h2>Research questions</h2>
        <ul>{project.data.researchQuestions.map((item) => <li key={item.id}>{item.text}</li>)}</ul>
      </section>
      <section className="card">
        <h2>Criteria</h2>
        <ul>{project.data.criteria.map((item) => <li key={item.id}><strong>{item.kind}:</strong> {item.text}</li>)}</ul>
      </section>
    </main>
  )
}
