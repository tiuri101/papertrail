import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Outlet, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import {
  type SectionNavigationItem,
  SectionNavigationLayout,
} from '../../components/SectionNavigationLayout'
import { useProjectDocumentTitle } from './useProjectDocumentTitle'

interface ProjectContext {
  name: string
}

export function ProjectSectionLayout() {
  const { projectId = '' } = useParams()
  const [sectionItems, setSectionItems] = useState<SectionNavigationItem[]>([])
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectContext>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  useProjectDocumentTitle(project.data?.name)

  return (
    <SectionNavigationLayout
      items={sectionItems}
      backTo={`/projects/${projectId}`}
      backLabel={project.data?.name ?? 'Project'}
    >
      <Outlet context={{ setSectionItems }} />
    </SectionNavigationLayout>
  )
}
