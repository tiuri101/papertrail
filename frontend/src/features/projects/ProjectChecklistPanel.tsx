import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

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

interface ChecklistAction {
  path: string
  label: string
  managerOnly?: boolean
}

const CHECKLIST_ACTIONS: Record<string, ChecklistAction> = {
  research_questions: { path: 'research-agenda', label: 'Add research questions' },
  criteria: { path: 'research-agenda', label: 'Edit inclusion/exclusion criteria' },
  publications: { path: 'imports', label: 'Import publications' },
  reviewers: { path: 'admin#section-project-members', label: 'Manage reviewers', managerOnly: true },
  detection: { path: 'duplicates', label: 'Open duplicate detection' },
  resolve_duplicates: { path: 'duplicates', label: 'Review duplicate candidates' },
  title_abstract_decisions: { path: 'screening/title_abstract', label: 'Open title/abstract screening' },
  full_text_retrieval: { path: 'full-text', label: 'Resolve full-text retrievals' },
  full_text_decisions: { path: 'full-text', label: 'Screen retrieved full texts' },
  extraction_form: { path: 'forms', label: 'Create extraction form', managerOnly: true },
  extraction: { path: 'extraction', label: 'Open data extraction' },
  llm_extraction_validation: { path: 'extraction/validation', label: 'Review LLM validation' },
  quality: { path: 'quality', label: 'Open quality assessment' },
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
          {currentStage.items.map((item) => {
            const action = CHECKLIST_ACTIONS[item.key]
            const showAction = !item.done && action && (!action.managerOnly || canManage)
            return (
              <li
                key={item.key}
                className={`checklist-item checklist-item--${item.done ? 'complete' : 'open'}`}
              >
                <label>
                  <input type="checkbox" checked={item.done} readOnly disabled />
                  <span className="checklist-item__content">
                    <span>{item.label}</span>
                    <span className="checklist-item__detail">{item.detail}</span>
                  </span>
                  <span className="checklist-item__status">{item.done ? 'Completed' : 'Open'}</span>
                </label>
                {showAction ? (
                  <Link className="checklist-item__action" to={`/projects/${projectId}/${action.path}`}>
                    {action.label}
                    <IconArrowRight />
                  </Link>
                ) : null}
              </li>
            )
          })}
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
      {currentStage.action === 'ready' && allItemsDone && !canManage ? (
        <p className="checklist-waiting" role="status">
          Waiting for the project owner to move this project
          {nextStageLabel ? ` to ${nextStageLabel}` : ' to the next stage'}.
        </p>
      ) : null}
      {currentStage.autoAdvances ? (
        <p className="muted">Moves to the next stage automatically once everything above is checked off.</p>
      ) : null}
    </section>
  )
}
