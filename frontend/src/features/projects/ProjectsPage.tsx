import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface Project {
  id: string
  name: string
  reviewType: string
  stage: string
}

export function ProjectsPage() {
  const queryClient = useQueryClient()
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
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  return (
    <main className="page">
      <h1>Projects</h1>
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
        </form>
      </section>
      {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
      {projects.isLoading ? <p>Loading…</p> : null}
      {projects.error ? <p className="error" role="alert">{projects.error.message}</p> : null}
      <ul>
        {projects.data?.map((project) => (
          <li key={project.id}>
            <Link to={`/projects/${project.id}`}>{project.name}</Link>
            {' — '}{project.stage}
          </li>
        ))}
      </ul>
    </main>
  )
}
