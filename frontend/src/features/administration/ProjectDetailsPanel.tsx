import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'

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
    mutationFn: (next: { name: string; description: string }) => apiRequest<ProjectDetails>(`/api/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: next.name, description: next.description.trim() || null }),
    }),
    onSuccess: (result) => {
      queryClient.setQueryData(['project', projectId], (previous: unknown) => ({
        ...(previous as object ?? {}),
        ...result,
      }))
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const saveIfChanged = () => {
    if (!project.data) return
    if (name.trim().length === 0) return
    if (name === project.data.name && description === (project.data.description ?? '')) return
    save.mutate({ name, description })
  }

  return (
    <CollapsibleSection id="section-project-details" title="Project Details">
      <p className="muted">Changes save automatically when you leave a field.</p>
      {project.error ? <p className="error" role="alert">{project.error.message}</p> : null}
      <label>
        Name
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={saveIfChanged}
          required
          maxLength={250}
        />
      </label>
      <label>
        Description
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={saveIfChanged}
          rows={3}
        />
      </label>
      {save.error ? <p className="error" role="alert">{save.error.message}</p> : null}
      <p className="muted" aria-live="polite">
        {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved.' : ' '}
      </p>
    </CollapsibleSection>
  )
}
