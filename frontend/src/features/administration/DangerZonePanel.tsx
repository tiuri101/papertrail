import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { describeError } from '../../api/domainErrors'
import { DangerZoneConfirmButton, DangerZoneSection } from '../../components/DangerZoneSection'
import { IconRestart, IconTrash } from '../../components/icons'
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
      <DangerZoneSection
        id="section-reset-project"
        title="Reset Project"
        icon={<IconRestart />}
        description={
          <>
            Wipes every imported publication and all screening, duplicate-review, full-text,
            extraction, and quality-assessment progress, and returns the project to draft.
            Research questions, criteria, screening configuration, and membership are kept. This
            cannot be undone.
          </>
        }
      >
        {/* A reset refused because a handler is mid-write (409
            `project_jobs_running`) is a wait-and-retry, not a failure --
            say which jobs, rather than surfacing a bare conflict. */}
        {reset.error ? <p className="text-danger" role="alert">{describeError(reset.error)}</p> : null}
        {reset.isSuccess ? <p>Project has been reset to draft.</p> : null}
        <div className={toolbarClass}>
          <DangerZoneConfirmButton
            label="Reset Project"
            confirmLabel="Reset Project"
            warning="Are you sure you want to continue? This cannot be undone."
            onConfirm={() => reset.mutate()}
            disabled={reset.isPending}
            icon={<IconRestart />}
          />
        </div>
      </DangerZoneSection>
      <DangerZoneSection
        id="section-delete-project"
        title="Delete Project"
        icon={<IconTrash />}
        description={
          <>
            Permanently removes the entire project, including its configuration, publications,
            stored PDFs, import files, and generated exports. This cannot be undone.
          </>
        }
      >
        {deleteProject.error ? <p className="text-danger" role="alert">{describeError(deleteProject.error)}</p> : null}
        <div className={toolbarClass}>
          <DangerZoneConfirmButton
            label="Delete Project"
            confirmLabel="Permanently Delete"
            warning="Are you sure you want to continue? This cannot be undone."
            onConfirm={() => deleteProject.mutate()}
            disabled={deleteProject.isPending}
            icon={<IconTrash />}
          />
        </div>
      </DangerZoneSection>
    </>
  )
}
