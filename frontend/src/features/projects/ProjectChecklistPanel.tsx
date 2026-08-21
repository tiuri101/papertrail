import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { IconArrowRight, IconChart, IconCheckCircle, IconDownload, IconEye } from '../../components/icons'
import { STAGES } from './StageProgress'
import { cn } from '../../lib/cn'

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
    <Card as="section" id="section-project-checklist">
      <h2>What&apos;s Next: {currentStage.label}</h2>
      {markReady.error ? <p className="error" role="alert">{markReady.error.message}</p> : null}
      {currentStage.items.length ? (
        <ul className="m-0 grid list-none gap-3 p-0">
          {currentStage.items.map((item) => {
            const action = CHECKLIST_ACTIONS[item.key]
            const showAction = !item.done && action && (!action.managerOnly || canManage)
            return (
              <li
                key={item.key}
                className={cn(
                  'rounded-md border transition-[border-color,background-color] duration-150',
                  item.done ? 'border-success/35 bg-success-container' : 'border-warning/40 bg-warning-container',
                )}
                data-state={item.done ? 'complete' : 'open'}
              >
                <label className="flex items-start gap-3 p-3 font-medium text-text max-[520px]:flex-wrap">
                  <input className={cn('mt-[3px] size-[18px] shrink-0 opacity-100', item.done ? 'accent-success' : 'accent-warning')} type="checkbox" checked={item.done} readOnly disabled />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span>{item.label}</span>
                    <span className="text-sm font-normal text-text">{item.detail}</span>
                  </span>
                  <Badge variant={item.done ? 'success' : 'warning'} className="shrink-0 max-[520px]:ml-7">
                    {item.done ? 'Completed' : 'Open'}
                  </Badge>
                </label>
                {showAction ? (
                  <Link className="mx-3 mb-3 ml-10 inline-flex items-center gap-2 text-sm font-bold [&_svg]:size-4 [&_svg]:fill-current" to={`/projects/${projectId}/${action.path}`}>
                    {action.label}
                    <IconArrowRight />
                  </Link>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : currentStage.stage === 'completed' ? (
        <div className="flex items-start gap-4 rounded-md border border-success/35 bg-success-container p-5 max-[520px]:p-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/20 text-success [&_svg]:size-6 [&_svg]:fill-current" aria-hidden="true">
            <IconCheckCircle />
          </span>
          <div className="min-w-0">
            <h3 className="m-0">Your review is complete</h3>
            <p className="mt-1 text-text-secondary">
              Explore your final results and analysis, or generate the reports and exports you
              need to share your findings.
            </p>
            <div className="mt-4 flex flex-wrap gap-3 max-[520px]:w-full">
              <Button as={Link} variant="primary" className="max-[520px]:w-full" startIcon={<IconEye />} to={`/projects/${projectId}/results`}>
                View Final Results
              </Button>
              <Button as={Link} variant="secondary" className="max-[520px]:w-full" startIcon={<IconChart />} to={`/projects/${projectId}/analysis`}>
                Explore Charts &amp; Analysis
              </Button>
              <Button as={Link} variant="secondary" className="max-[520px]:w-full" startIcon={<IconDownload />} to={`/projects/${projectId}/reporting`}>
                Open Reporting and Exports
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="muted">Nothing left to do here.</p>
      )}
      {currentStage.action === 'ready' && canManage ? (
        <Button
          type="button"
          endIcon={<IconArrowRight />}
          onClick={() => markReady.mutate()}
          disabled={markReady.isPending || !allItemsDone}
        >
          {nextStageLabel ? `Move Project to ${nextStageLabel}` : 'Mark Project Ready'}
        </Button>
      ) : null}
      {currentStage.action === 'ready' && allItemsDone && !canManage ? (
        <p className="mt-4 rounded-md border border-primary/30 bg-primary-container px-4 py-3 font-bold text-primary" role="status">
          Waiting for the project owner to move this project
          {nextStageLabel ? ` to ${nextStageLabel}` : ' to the next stage'}.
        </p>
      ) : null}
      {currentStage.autoAdvances ? (
        <p className="muted">Moves to the next stage automatically once everything above is checked off.</p>
      ) : null}
    </Card>
  )
}
