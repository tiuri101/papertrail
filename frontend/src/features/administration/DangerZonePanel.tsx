import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'

export function DangerZonePanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const reset = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/reset`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-dashboard', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-integrity', projectId] })
      queryClient.invalidateQueries({ queryKey: ['publications', projectId] })
    },
  })

  const deleteProject = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      navigate('/projects')
    },
  })

  const mutationError = reset.error ?? deleteProject.error

  return (
    <section className="card">
      <h2>Danger zone</h2>
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      {reset.isSuccess ? <p>Project has been reset to draft.</p> : null}
      <div className="toolbar">
        <ConfirmButton
          label="Reset project"
          confirmLabel="Reset project"
          warning="This deletes every imported publication and all screening, duplicate-review, full-text, extraction, and quality-assessment progress, and returns the project to draft. Research questions, criteria, screening configuration, and membership are kept. This cannot be undone."
          onConfirm={() => reset.mutate()}
          disabled={reset.isPending || deleteProject.isPending}
        />
        <ConfirmButton
          label="Delete project"
          confirmLabel="Permanently delete"
          warning="This permanently deletes the entire project, including its configuration, publications, and all progress. This cannot be undone."
          onConfirm={() => deleteProject.mutate()}
          disabled={reset.isPending || deleteProject.isPending}
        />
      </div>
    </section>
  )
}
