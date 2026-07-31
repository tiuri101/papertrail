import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'

interface ProjectDetails {
  id: string
  name: string
  description: string | null
}

export function ProjectDetailsPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetails>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    if (project.data) {
      setName(project.data.name)
      setDescription(project.data.description ?? '')
    }
  }, [project.data])

  const save = useMutation({
    mutationFn: () => apiRequest<ProjectDetails>(`/api/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, description: description.trim() || null }),
    }),
    onSuccess: (result) => {
      queryClient.setQueryData(['project', projectId], (previous: unknown) => ({
        ...(previous as object ?? {}),
        ...result,
      }))
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  return (
    <section className="card">
      <h2>Project details</h2>
      {project.error ? <p className="error" role="alert">{project.error.message}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
        <label>
          Name
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={250}
          />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
          />
        </label>
        {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
        {save.isSuccess ? <p>Project details saved.</p> : null}
        <button type="submit" disabled={save.isPending || name.trim().length === 0}>
          Save changes
        </button>
      </form>
    </section>
  )
}
