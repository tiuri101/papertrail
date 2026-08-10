import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconCheckCircle, IconFolder } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'

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

  return (
    <CollapsibleSection id="section-project-details" title="Project Details" icon={<IconFolder />}>
      <InfoBox icon={<IconFolder />}>
        <p>
          The name and description shown across the app wherever this project is listed. Changes
          here take effect immediately for every member.
        </p>
      </InfoBox>
      {project.error ? <p className="error" role="alert">{project.error.message}</p> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate({ name, description })
        }}
      >
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
        <button type="submit" disabled={save.isPending}>
          <IconCheckCircle />
          {save.isPending ? 'Saving…' : 'Save Project Details'}
        </button>
        <p className="muted" aria-live="polite">
          {save.isSuccess ? 'Saved.' : ' '}
        </p>
      </form>
    </CollapsibleSection>
  )
}
