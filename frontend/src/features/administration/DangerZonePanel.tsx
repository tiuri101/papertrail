import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconAlertTriangle, IconRestart, IconTrash } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { toolbarClass } from '../../components/layoutStyles'

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

  return (
    <>
      <CollapsibleSection id="section-reset-project" title="Reset Project" tone="danger" icon={<IconRestart />}>
        <InfoBox icon={<IconAlertTriangle />} tone="warning">
          <p>
            Wipes every imported publication and all screening, duplicate-review, full-text,
            extraction, and quality-assessment progress, and returns the project to draft.
            Research questions, criteria, screening configuration, and membership are kept. This
            cannot be undone.
          </p>
        </InfoBox>
        {reset.error ? <p className="text-danger" role="alert">{reset.error.message}</p> : null}
        {reset.isSuccess ? <p>Project has been reset to draft.</p> : null}
        <div className={toolbarClass}>
          <ConfirmButton
            label="Reset Project"
            confirmLabel="Reset Project"
            warning="Are you sure you want to continue? This cannot be undone."
            onConfirm={() => reset.mutate()}
            disabled={reset.isPending}
            variant="danger"
            icon={<IconRestart />}
          />
        </div>
      </CollapsibleSection>
      <CollapsibleSection id="section-delete-project" title="Delete Project" tone="danger" icon={<IconTrash />}>
        <InfoBox icon={<IconAlertTriangle />} tone="warning">
          <p>
            Permanently removes the entire project, including its configuration, publications,
            stored PDFs, import files, and generated exports. This cannot be undone.
          </p>
        </InfoBox>
        {deleteProject.error ? <p className="text-danger" role="alert">{deleteProject.error.message}</p> : null}
        <div className={toolbarClass}>
          <ConfirmButton
            label="Delete Project"
            confirmLabel="Permanently Delete"
            warning="Are you sure you want to continue? This cannot be undone."
            onConfirm={() => deleteProject.mutate()}
            disabled={deleteProject.isPending}
            variant="danger"
            icon={<IconTrash />}
          />
        </div>
      </CollapsibleSection>
    </>
  )
}
