import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { apiRequest } from '../../api/client'
import { IconArrowRight } from '../../components/icons'
import { STAGES } from './StageProgress'

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

export function ProjectChecklistPanel({ projectId, canManage }: { projectId: string; canManage: boolean }) {
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

  const currentStageIndex = checklist.data.stages.findIndex((stage) => stage.isCurrent)
  const currentStage = checklist.data.stages[currentStageIndex]
  if (!currentStage) return null

  const allItemsDone = currentStage.items.every((item) => item.done)
  const nextStage = checklist.data.stages[currentStageIndex + 1]
  const nextStageLabel = nextStage
    ? STAGES.find((stage) => stage.value === nextStage.stage)?.label ?? nextStage.label
    : null

  return (
    <section id="section-project-checklist" className="card">
      <h2>What&apos;s Next: {currentStage.label}</h2>
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
      {currentStage.action === 'ready' && canManage ? (
        <button
          type="button"
          onClick={() => markReady.mutate()}
          disabled={markReady.isPending || !allItemsDone}
        >
          {nextStageLabel ? `Move Project to ${nextStageLabel}` : 'Mark Project Ready'}
          <IconArrowRight />
        </button>
      ) : null}
      {currentStage.autoAdvances ? (
        <p className="muted">Moves to the next stage automatically once everything above is checked off.</p>
      ) : null}
    </section>
  )
}
