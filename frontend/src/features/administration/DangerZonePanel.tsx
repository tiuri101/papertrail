import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconRestart, IconTrash } from '../../components/icons'

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
    <CollapsibleSection id="section-danger-zone" title="Danger Zone" className="danger-zone">
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      {reset.isSuccess ? <p>Project has been reset to draft.</p> : null}
      <div className="toolbar">
        <ConfirmButton
          label="Reset Project"
          confirmLabel="Reset Project"
          warning="This deletes every imported publication and all screening, duplicate-review, full-text, extraction, and quality-assessment progress, and returns the project to draft. Research questions, criteria, screening configuration, and membership are kept. This cannot be undone."
          onConfirm={() => reset.mutate()}
          disabled={reset.isPending || deleteProject.isPending}
          variant="danger"
          icon={<IconRestart />}
        />
        <ConfirmButton
          label="Delete Project"
          confirmLabel="Permanently Delete"
          warning="This permanently deletes the entire project, including its configuration, publications, stored PDFs, import files, generated exports, and all progress. This cannot be undone."
          onConfirm={() => deleteProject.mutate()}
          disabled={reset.isPending || deleteProject.isPending}
          variant="danger"
          icon={<IconTrash />}
        />
      </div>
    </CollapsibleSection>
  )
}
