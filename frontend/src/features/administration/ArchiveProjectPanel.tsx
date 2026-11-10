import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { describeError } from '../../api/domainErrors'
import { DangerZoneConfirmButton, DangerZoneSection } from '../../components/DangerZoneSection'
import { IconArchive } from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'

export function ArchiveProjectPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<{ archivedAt: string | null }>(`/api/v1/projects/${projectId}`),
  })
  const archived = Boolean(project.data?.archivedAt)

  const toggle = useMutation({
    mutationFn: (action: 'archive' | 'unarchive') =>
      apiRequest(`/api/v1/projects/${projectId}/${action}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  return (
    <DangerZoneSection
      id="section-archive-project"
      title="Archive Project"
      icon={<IconArchive />}
      description={archived
        ? 'This project is archived. It is hidden from the project overview and listed under Archived projects instead. Restoring it returns it to the overview.'
        : 'Hides the project from the project overview for every member; it stays available under Archived projects and can be restored at any time. Nothing is deleted, and every project member is notified by email.'}
    >
      {toggle.error ? <p className="text-danger" role="alert">{describeError(toggle.error)}</p> : null}
      {project.data ? (
        <div className={toolbarClass}>
          {archived ? (
            <DangerZoneConfirmButton
              label="Restore Project"
              confirmLabel="Restore"
              warning="Restore this project to the project overview?"
              onConfirm={() => toggle.mutate('unarchive')}
              disabled={toggle.isPending}
              icon={<IconArchive />}
            />
          ) : (
            <DangerZoneConfirmButton
              label="Archive Project"
              confirmLabel="Archive"
              warning="Archive this project? All project members will be notified by email."
              onConfirm={() => toggle.mutate('archive')}
              disabled={toggle.isPending}
              icon={<IconArchive />}
            />
          )}
        </div>
      ) : null}
    </DangerZoneSection>
  )
}
