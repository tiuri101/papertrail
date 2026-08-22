import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { IconArrowRight, IconCheckCircle, IconFolder } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Page } from '../../components/Page'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { Textarea } from '../../components/Textarea'
import { CriteriaPanel, ResearchQuestionsPanel } from '../administration/ResearchAgendaPanel'
import { HighlightKeywordsPanel } from '../administration/HighlightKeywordsPanel'
import { MembersPanel } from '../administration/MembersPanel'
import { ExtractionSettingsPanel } from '../administration/ExtractionSettingsPanel'
import { ScreeningConfigPanel } from '../administration/ScreeningConfigPanel'
import { FormFieldsPanel } from '../forms/FormFieldsPanel'
import { LlmAssistancePanel, type LlmAssistancePanelHandle } from '../llm/LlmAssistancePanel'
import { STAGES } from './StageProgress'
import { cn } from '../../lib/cn'

interface ProjectDetails {
  id: string
  name: string
  description: string | null
  reviewType: string
}

const reviewTypeOptions: Array<{ value: string; label: string }> = [
  { value: 'systematic_review', label: 'Systematic review' },
  { value: 'scoping_review', label: 'Scoping review' },
  { value: 'systematic_mapping', label: 'Systematic mapping study' },
  { value: 'other', label: 'Other' },
]

interface WizardStep {
  key: string
  label: string
  optional?: boolean
}

const WIZARD_STEPS: WizardStep[] = [
  { key: 'details', label: 'Project Details' },
  { key: 'questions', label: 'Research Questions' },
  { key: 'criteria', label: 'Inclusion / Exclusion' },
  { key: 'reviewers', label: 'Reviewers' },
  { key: 'screening', label: 'Screening Config' },
  { key: 'extraction', label: 'Extraction Form' },
  { key: 'quality', label: 'QA Form', optional: true },
  { key: 'keywords', label: 'Keywords' },
  { key: 'llm', label: 'LLM Assistance', optional: true },
]

function ProjectDetailsStep({
  projectId,
  onCreated,
  onContinue,
}: {
  projectId: string
  onCreated: (id: string) => void
  onContinue: () => void
}) {
  const queryClient = useQueryClient()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetails>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [reviewType, setReviewType] = useState('systematic_review')

  useEffect(() => {
    if (project.data) {
      setName(project.data.name)
      setDescription(project.data.description ?? '')
      setReviewType(project.data.reviewType)
    }
  }, [project.data])

  const create = useMutation({
    mutationFn: () => apiRequest<ProjectDetails>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name, description: description.trim() || null, reviewType }),
    }),
    onSuccess: (result) => {
      // The create endpoint only returns a project summary, not the full
      // detail shape (research questions, criteria, screening configs, ...)
      // that other steps' panels expect from the shared ['project', id]
      // cache entry, so let them fetch it fresh instead of seeding here.
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      onCreated(result.id)
    },
  })
  const update = useMutation({
    mutationFn: () => apiRequest<ProjectDetails>(`/api/v1/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, description: description.trim() || null }),
    }),
    onSuccess: (result) => {
      queryClient.setQueryData(['project', projectId], (previous: unknown) => ({
        ...(previous as object ?? {}),
        ...result,
      }))
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      onContinue()
    },
  })

  const pending = create.isPending || update.isPending
  const error = create.error ?? update.error

  return (
    <Card as="section">
      <h2>
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex shrink-0 text-primary [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true"><IconFolder /></span>
          Project Name and Description
        </span>
      </h2>
      <InfoBox icon={<IconFolder />}>
        <p>
          Give the project a clear name and a short description of its scope. You can revisit
          every step but this one later from the project&apos;s Project Administration page.
        </p>
      </InfoBox>
      {project.isLoading ? <p>Loading…</p> : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (projectId) update.mutate()
            else create.mutate()
          }}
        >
          <label>
            Project name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={250}
            />
          </label>
          <label>
            Description
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </label>
          <label>
            Review type
            <Select
              value={reviewType}
              onChange={(event) => setReviewType(event.target.value)}
              disabled={Boolean(projectId)}
            >
              {reviewTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </label>
          {projectId ? <p className="text-text">Review type can&apos;t be changed after the project is created.</p> : null}
          {error ? <p className="text-danger" role="alert">{error.message}</p> : null}
          <Button type="submit" disabled={pending || name.trim().length === 0} endIcon={<IconArrowRight />}>
            {projectId ? 'Save & Continue' : 'Create Project & Continue'}
          </Button>
        </form>
      )}
    </Card>
  )
}

export function ProjectSetupWizard() {
  const { projectId: routeProjectId } = useParams()
  const navigate = useNavigate()
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const [stepDirty, setStepDirty] = useState(false)
  const [isFinishing, setIsFinishing] = useState(false)
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)
  const projectId = routeProjectId ?? createdProjectId ?? ''
  const currentStepRef = useRef<HTMLLIElement>(null)
  const llmPanelRef = useRef<LlmAssistancePanelHandle>(null)

  useEffect(() => {
    currentStepRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [step])

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetails>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  const guardedNavigate = (action: () => void) => {
    if (!stepDirty) {
      action()
      return
    }
    setPendingAction(() => action)
  }

  const goTo = (index: number) => {
    guardedNavigate(() => {
      setStepDirty(false)
      setStep(Math.max(0, Math.min(WIZARD_STEPS.length - 1, index)))
    })
  }
  const isLastStep = step === WIZARD_STEPS.length - 1

  const finish = async () => {
    setIsFinishing(true)
    try {
      await llmPanelRef.current?.finishSetup()
      setStepDirty(false)
      navigate(`/projects/${projectId}`)
    } catch {
      // The LLM panel displays the mutation error and keeps the wizard open.
    } finally {
      setIsFinishing(false)
    }
  }

  return (
    <Page>
      <div className="grid grid-cols-[max-content_minmax(0,1fr)] grid-rows-[auto_1fr] items-start gap-x-8 gap-y-6 max-[760px]:grid-cols-1 max-[760px]:grid-rows-none max-[760px]:gap-5">
        <div className="col-start-2 row-start-1 max-[760px]:col-start-1 max-[760px]:row-auto [&>h1]:m-0">
          <p className="mb-1 block text-xs font-bold uppercase tracking-[0.08em] text-primary">Project setup · Step {step + 1} of {WIZARD_STEPS.length}</p>
          <h1>Project Setup Wizard</h1>
          <p className="text-text">
            {project.data?.name
              ? `Setting up "${project.data.name}". Every step but the first can be revisited later from the project's Project Administration page.`
              : 'Create a project by walking through each setup step. You can finish the rest later from the project\'s Project Administration page.'}
          </p>
        </div>

        <nav className="sticky top-6 col-start-1 row-start-2 max-[760px]:static max-[760px]:row-auto max-[760px]:overflow-x-auto max-[760px]:[scrollbar-width:thin]" aria-label="Project setup steps">
          <ol className="m-0 flex list-none flex-col p-0 max-[760px]:w-fit max-[760px]:min-w-full max-[760px]:flex-row max-[760px]:gap-2">
            {WIZARD_STEPS.map((wizardStep, index) => {
              const isCurrent = index === step
              const isDone = index < step
              const clickable = Boolean(projectId) || index === 0
              const stageColor = STAGES[index % STAGES.length].color
              return (
                <li
                  key={wizardStep.key}
                  ref={isCurrent ? currentStepRef : undefined}
                  className={cn(
                    "relative max-[760px]:min-w-[150px] max-[760px]:flex-auto not-last:before:absolute not-last:before:top-[calc(0.75rem+26px)] not-last:before:left-[calc(1rem+13px)] not-last:before:h-6 not-last:before:w-0.5 not-last:before:bg-border not-last:before:content-[''] max-[760px]:not-last:before:top-[25px] max-[760px]:not-last:before:right-[-1rem] max-[760px]:not-last:before:left-[42px] max-[760px]:not-last:before:h-0.5 max-[760px]:not-last:before:w-auto",
                    isDone && 'not-last:before:bg-success-container',
                  )}
                  style={{ '--stage-color': stageColor } as CSSProperties}
                >
                  <button
                    type="button"
                    className={cn('relative flex !h-auto w-full items-center justify-start gap-3 rounded-md border-0 bg-none py-3 pr-3 pl-4 text-left text-text-secondary shadow-none hover:bg-surface-hover hover:text-text disabled:cursor-not-allowed', isCurrent && 'bg-[color-mix(in_srgb,var(--stage-color)_14%,transparent)]')}
                    disabled={!clickable}
                    aria-current={isCurrent ? 'step' : undefined}
                    onClick={() => goTo(index)}
                  >
                    <span className={cn(
                      'inline-grid size-[26px] shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--stage-color)_18%,transparent)] text-[0.78rem] font-bold text-(--stage-color)',
                      isCurrent && 'bg-(--stage-color) text-white shadow-[0_0_0_4px_color-mix(in_srgb,var(--stage-color)_22%,transparent)]',
                      isDone && 'bg-success-container text-success',
                    )}>{isDone ? '✓' : index + 1}</span>
                    <span className={cn('text-[0.85rem] leading-[1.3] font-semibold whitespace-nowrap max-[760px]:text-[0.8rem]', isCurrent && 'font-bold text-(--stage-color)')}>
                      {wizardStep.label}
                      {wizardStep.optional ? <span className="text-text"> (optional)</span> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className="col-start-2 row-start-2 flex min-w-0 flex-col gap-6 max-[760px]:col-start-1 max-[760px]:row-auto">
          {WIZARD_STEPS[step].key === 'details' ? (
            <ProjectDetailsStep
              projectId={projectId}
              onCreated={(id) => { setCreatedProjectId(id); goTo(1) }}
              onContinue={() => goTo(1)}
            />
          ) : null}
          {WIZARD_STEPS[step].key === 'questions' ? (
            <ResearchQuestionsPanel projectId={projectId} onDirtyChange={setStepDirty} inlineAdd />
          ) : null}
          {WIZARD_STEPS[step].key === 'criteria' ? (
            <CriteriaPanel projectId={projectId} onDirtyChange={setStepDirty} inlineAdd />
          ) : null}
          {WIZARD_STEPS[step].key === 'reviewers' ? (
            <MembersPanel projectId={projectId} onDirtyChange={setStepDirty} />
          ) : null}
          {WIZARD_STEPS[step].key === 'screening' ? (
            <ScreeningConfigPanel projectId={projectId} onDirtyChange={setStepDirty} />
          ) : null}
          {WIZARD_STEPS[step].key === 'extraction' ? (
            <>
              <ExtractionSettingsPanel projectId={projectId} />
              <FormFieldsPanel
                projectId={projectId}
                kind="extraction"
                title="Data Extraction Form"
                description="Define the fields reviewers fill in when extracting data from included publications."
                inlineAdd
                onDirtyChange={setStepDirty}
              />
            </>
          ) : null}
          {WIZARD_STEPS[step].key === 'quality' ? (
            <FormFieldsPanel
              projectId={projectId}
              kind="quality"
              title="Quality Assessment Form (optional)"
              description="Optionally define a form for assessing the methodological quality of included publications."
              inlineAdd
              onDirtyChange={setStepDirty}
            />
          ) : null}
          {WIZARD_STEPS[step].key === 'keywords' ? (
            <HighlightKeywordsPanel projectId={projectId} />
          ) : null}
          {WIZARD_STEPS[step].key === 'llm' ? (
            <LlmAssistancePanel
              ref={llmPanelRef}
              projectId={projectId}
              showProcessingStatus={false}
              onDirtyChange={setStepDirty}
              setupMode
            />
          ) : null}

          {WIZARD_STEPS[step].key !== 'details' ? (
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3 max-[760px]:grid max-[760px]:grid-cols-2 max-[480px]:gap-2 [&>button]:max-[760px]:w-full">
                <Button type="button" variant="ghost" onClick={() => goTo(step - 1)}>
                  Back
                </Button>
                {isLastStep ? (
                  <Button type="button" onClick={finish} loading={isFinishing}>
                    <IconCheckCircle />
                    {isFinishing ? 'Finishing…' : 'Finish Setup'}
                  </Button>
                ) : (
                  <Button type="button" onClick={() => goTo(step + 1)}>
                    {WIZARD_STEPS[step].optional ? 'Skip / Next' : 'Next'}
                    <IconArrowRight />
                  </Button>
                )}
              </div>
              <Button
                as={Link}
                to={`/projects/${projectId}`}
                variant="text"
                className="justify-self-end text-center max-[760px]:w-full max-[760px]:justify-self-stretch"
                onClick={(event) => {
                  if (!stepDirty) return
                  event.preventDefault()
                  guardedNavigate(() => navigate(`/projects/${projectId}`))
                }}
              >
                Finish later
              </Button>
            </div>
          ) : (
            !projectId ? (
              <div className="grid gap-2">
                <Button as={Link} to="/projects" variant="text">Cancel</Button>
              </div>
            ) : null
          )}
        </div>
      </div>
      {pendingAction ? (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="You have unsaved changes on this step. Leaving now will discard them."
          confirmLabel="Discard & Continue"
          cancelLabel="Stay on this step"
          variant="danger"
          onConfirm={() => {
            const action = pendingAction
            setPendingAction(null)
            action()
          }}
          onCancel={() => setPendingAction(null)}
        />
      ) : null}
    </Page>
  )
}
