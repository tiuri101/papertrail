import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { cn } from '../../lib/cn'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Button } from '../../components/Button'
import { IconArrowRight, IconCheckCircle, IconFolder } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { CriteriaPanel, ResearchQuestionsPanel } from '../administration/ResearchAgendaPanel'
import { HighlightKeywordsPanel } from '../administration/HighlightKeywordsPanel'
import { MembersPanel } from '../administration/MembersPanel'
import { ExtractionSettingsPanel } from '../administration/ExtractionSettingsPanel'
import { ScreeningConfigPanel } from '../administration/ScreeningConfigPanel'
import { FormFieldsPanel } from '../forms/FormFieldsPanel'
import { LlmAssistancePanel, type LlmAssistancePanelHandle } from '../llm/LlmAssistancePanel'
import { STAGES } from './StageProgress'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { Textarea } from '../../components/Textarea'
import { Page } from '../../components/Page'
import { FieldLabel } from '../../components/FieldLabel'
import { Form } from '../../components/Form'

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
    <section className="card">
      <h2>
        <span className="collapsible-section__title inline-flex items-center gap-2">
          <span className="collapsible-section__icon inline-flex shrink-0 text-primary [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true"><IconFolder /></span>
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
        <Form
          onSubmit={(event) => {
            event.preventDefault()
            if (projectId) update.mutate()
            else create.mutate()
          }}
        >
          <FieldLabel>
            Project name
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={250}
            />
          </FieldLabel>
          <FieldLabel>
            Description
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </FieldLabel>
          <FieldLabel>
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
          </FieldLabel>
          {projectId ? <p className="muted">Review type can&apos;t be changed after the project is created.</p> : null}
          {error ? <p className="error" role="alert">{error.message}</p> : null}
          <Button type="submit" disabled={pending || name.trim().length === 0}>
            {projectId ? 'Save & Continue' : 'Create Project & Continue'}
            <IconArrowRight />
          </Button>
        </Form>
      )}
    </section>
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
      <div className="project-wizard grid grid-cols-[max-content_minmax(0,1fr)] grid-rows-[auto_1fr] items-start gap-x-8 gap-y-6 max-[760px]:grid-cols-1 max-[760px]:grid-rows-none max-[760px]:gap-5">
        <div className="project-wizard__header col-start-2 row-start-1 max-[760px]:col-start-1 max-[760px]:row-auto">
          <p className="eyebrow mb-1 block text-[0.74rem] font-[750] tracking-[0.08em] text-primary uppercase">Project setup · Step {step + 1} of {WIZARD_STEPS.length}</p>
          <h1 className="m-0">Project Setup Wizard</h1>
          <p className="muted mt-1">
            {project.data?.name
              ? `Setting up "${project.data.name}". Every step but the first can be revisited later from the project's Project Administration page.`
              : 'Create a project by walking through each setup step. You can finish the rest later from the project\'s Project Administration page.'}
          </p>
        </div>

        <nav
          className="project-wizard__sidebar-wrap sticky top-6 col-start-1 row-start-2 max-[760px]:static max-[760px]:col-start-1 max-[760px]:row-auto max-[760px]:overflow-x-auto max-[760px]:[scrollbar-width:thin]"
          aria-label="Project setup steps"
        >
          <ol className="project-wizard__sidebar flex flex-col m-0 p-0 list-none max-[760px]:flex-row max-[760px]:w-fit max-[760px]:min-w-full max-[760px]:gap-2">
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
                    'wizard-step relative',
                    'max-[760px]:flex-1 max-[760px]:min-w-[150px] max-[760px]:pb-0',
                    "[&:not(:last-child)]:before:content-[''] [&:not(:last-child)]:before:absolute [&:not(:last-child)]:before:top-[38px] [&:not(:last-child)]:before:left-[29px] [&:not(:last-child)]:before:w-0.5 [&:not(:last-child)]:before:h-6",
                    'max-[760px]:[&:not(:last-child)]:before:top-[25px] max-[760px]:[&:not(:last-child)]:before:left-[42px] max-[760px]:[&:not(:last-child)]:before:right-[calc(var(--space-2)*-1)] max-[760px]:[&:not(:last-child)]:before:bottom-auto max-[760px]:[&:not(:last-child)]:before:w-auto max-[760px]:[&:not(:last-child)]:before:h-0.5',
                    isDone ? '[&:not(:last-child)]:before:bg-success-container' : '[&:not(:last-child)]:before:bg-border',
                  )}
                  style={{ '--stage-color': stageColor } as CSSProperties}
                >
                  <button
                    type="button"
                    className={cn(
                      'wizard-step__button relative flex w-full h-auto items-center justify-start gap-3 rounded-md border-0 bg-none py-3 pr-3 pl-4 text-left text-text-secondary shadow-none',
                      'hover:not-disabled:bg-surface-hover hover:not-disabled:text-text hover:not-disabled:shadow-none hover:not-disabled:scale-100',
                      'disabled:cursor-not-allowed disabled:shadow-none',
                      isCurrent && 'bg-[color-mix(in_srgb,var(--stage-color)_14%,transparent)]',
                    )}
                    disabled={!clickable}
                    aria-current={isCurrent ? 'step' : undefined}
                    onClick={() => goTo(index)}
                  >
                    <span
                      className={cn(
                        'wizard-step__index inline-grid h-[26px] w-[26px] flex-none place-items-center rounded-full text-[0.78rem] font-[760]',
                        isCurrent
                          ? 'bg-[var(--stage-color)] text-white shadow-[0_0_0_4px_color-mix(in_srgb,var(--stage-color)_22%,transparent)]'
                          : isDone
                            ? 'bg-success-container text-success'
                            : 'bg-[color-mix(in_srgb,var(--stage-color)_18%,transparent)] text-[var(--stage-color)]',
                      )}
                    >
                      {isDone ? '✓' : index + 1}
                    </span>
                    <span
                      className={cn(
                        'wizard-step__label text-[0.85rem] leading-[1.3] font-[640] whitespace-nowrap max-[760px]:text-[0.8rem]',
                        isCurrent && 'text-[var(--stage-color)] font-[720]',
                      )}
                    >
                      {wizardStep.label}
                      {wizardStep.optional ? <span className="muted"> (optional)</span> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className="project-wizard__main col-start-2 row-start-2 flex min-w-0 flex-col gap-6 max-[760px]:col-start-1 max-[760px]:row-auto">
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
            <div className="wizard-nav grid gap-2 my-5">
              <div className="wizard-nav__controls flex items-center justify-between gap-3 max-[760px]:grid max-[760px]:grid-cols-2 max-[480px]:gap-2">
                <Button type="button" variant="ghost" className="max-[760px]:w-full" onClick={() => goTo(step - 1)}>
                  Back
                </Button>
                {isLastStep ? (
                  <Button type="button" className="max-[760px]:w-full" onClick={finish} loading={isFinishing}>
                    <IconCheckCircle />
                    {isFinishing ? 'Finishing…' : 'Finish Setup'}
                  </Button>
                ) : (
                  <Button type="button" className="max-[760px]:w-full" onClick={() => goTo(step + 1)}>
                    {WIZARD_STEPS[step].optional ? 'Skip / Next' : 'Next'}
                    <IconArrowRight />
                  </Button>
                )}
              </div>
              <Button
                as={Link}
                variant="text"
                to={`/projects/${projectId}`}
                className="wizard-exit justify-self-end text-center max-[760px]:inline-flex max-[760px]:w-full max-[760px]:items-center max-[760px]:justify-center max-[760px]:justify-self-stretch"
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
              <div className="wizard-nav grid gap-2 my-5">
                <Button as={Link} variant="text" to="/projects">Cancel</Button>
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
