import { useQuery } from '@tanstack/react-query'

import { api } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconCheckCircle } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'

export function ProjectLifecyclePanel({ projectId }: { projectId: string }) {
  const integrity = useQuery({
    queryKey: ['project-integrity', projectId],
    queryFn: () => api<{ issues: Array<{ code: string; message: string }> }>(
      `/projects/${projectId}/integrity`,
    ),
  })

  return (
    <CollapsibleSection
      id="section-workflow-integrity"
      title="Workflow Integrity"
      icon={<IconCheckCircle />}
    >
      <InfoBox icon={<IconCheckCircle />}>
        <p>
          Automated checks for inconsistencies across a project's stages, such as decisions or
          data left over from a stage the project has already moved past.
        </p>
      </InfoBox>
      {integrity.data?.issues.length ? (
        <ul>
          {integrity.data.issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : <p>No consistency issues detected.</p>}
    </CollapsibleSection>
  )
}
