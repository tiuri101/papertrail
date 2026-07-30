import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { apiRequest } from '../../api/client'

interface ChecklistItem {
  key: string
  label: string
  done: boolean
  detail: string
}

interface ChecklistStage {
  stage: string
  label: string
  isCurrent: boolean
  isComplete: boolean
  items: ChecklistItem[]
  autoAdvances: boolean
  action: string | null
}

interface ProjectChecklist {
  stage: string
  stages: ChecklistStage[]
}

function currentStageIsIncomplete(data: ProjectChecklist | undefined): boolean {
  const currentStage = data?.stages.find((stage) => stage.isCurrent)
  if (!currentStage) return false
  return currentStage.items.some((item) => !item.done)
}

export function ProjectChecklistPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const checklist = useQuery({
    queryKey: ['project-checklist', projectId],
    queryFn: () => apiRequest<ProjectChecklist>(`/api/v1/projects/${projectId}/checklist`),
    enabled: Boolean(projectId),
    refetchInterval: (query) => (currentStageIsIncomplete(query.state.data) ? 3000 : false),
  })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['project-checklist', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    queryClient.invalidateQueries({ queryKey: ['project-dashboard', projectId] })
  }

  const markReady = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/ready`, { method: 'POST' }),
    onSuccess: refresh,
  })

  const previousStage = useRef<string | null>(null)
  useEffect(() => {
    const stage = checklist.data?.stage ?? null
    if (stage && previousStage.current && previousStage.current !== stage) {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project-dashboard', projectId] })
    }
    previousStage.current = stage ?? previousStage.current
  }, [checklist.data?.stage, projectId, queryClient])

  if (checklist.isLoading) return <p>Loading checklist…</p>
  if (checklist.isError || !checklist.data) return <p className="error" role="alert">Checklist could not be loaded.</p>

  const currentStage = checklist.data.stages.find((stage) => stage.isCurrent)
  if (!currentStage) return null

  const allItemsDone = currentStage.items.every((item) => item.done)

  return (
    <section className="card">
      <h2>What&apos;s next: {currentStage.label}</h2>
      {markReady.error ? <p className="error" role="alert">{markReady.error.message}</p> : null}
      {currentStage.items.length ? (
        <ul className="checklist-items">
          {currentStage.items.map((item) => (
            <li key={item.key}>
              <label>
                <input type="checkbox" checked={item.done} readOnly disabled />
                <span>{item.label} — <span className="muted">{item.detail}</span></span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing left to do here.</p>
      )}
      {currentStage.action === 'ready' ? (
        <button
          type="button"
          onClick={() => markReady.mutate()}
          disabled={markReady.isPending || !allItemsDone}
        >
          Mark project ready
        </button>
      ) : null}
      {currentStage.autoAdvances ? (
        <p className="muted">Moves to the next stage automatically once everything above is checked off.</p>
      ) : null}
    </section>
  )
}
