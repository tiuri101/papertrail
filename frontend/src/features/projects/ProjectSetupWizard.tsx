import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
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
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (projectId) update.mutate()
            else create.mutate()
          }}
        >
          <label>
            Project name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={250}
            />
          </label>
          <label>
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </label>
          <label>
            Review type
            <select
              value={reviewType}
              onChange={(event) => setReviewType(event.target.value)}
              disabled={Boolean(projectId)}
            >
              {reviewTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          {projectId ? <p className="muted">Review type can&apos;t be changed after the project is created.</p> : null}
          {error ? <p className="error" role="alert">{error.message}</p> : null}
          <Button type="submit" disabled={pending || name.trim().length === 0}>
            {projectId ? 'Save & Continue' : 'Create Project & Continue'}
            <IconArrowRight />
          </Button>
        </form>
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
    <main className="page">
      <div className="project-wizard">
        <div className="project-wizard__header">
          <p className="eyebrow">Project setup · Step {step + 1} of {WIZARD_STEPS.length}</p>
          <h1>Project Setup Wizard</h1>
          <p className="muted">
            {project.data?.name
              ? `Setting up "${project.data.name}". Every step but the first can be revisited later from the project's Project Administration page.`
              : 'Create a project by walking through each setup step. You can finish the rest later from the project\'s Project Administration page.'}
          </p>
        </div>

        <nav className="project-wizard__sidebar-wrap" aria-label="Project setup steps">
          <ol className="project-wizard__sidebar">
            {WIZARD_STEPS.map((wizardStep, index) => {
              const isCurrent = index === step
              const isDone = index < step
              const clickable = Boolean(projectId) || index === 0
              const stageColor = STAGES[index % STAGES.length].color
              return (
                <li
                  key={wizardStep.key}
                  ref={isCurrent ? currentStepRef : undefined}
                  className={
                    `wizard-step${isCurrent ? ' wizard-step--active' : ''}${isDone ? ' wizard-step--done' : ''}`
                  }
                  style={{ '--stage-color': stageColor } as CSSProperties}
                >
                  <button
                    type="button"
                    className="wizard-step__button"
                    disabled={!clickable}
                    aria-current={isCurrent ? 'step' : undefined}
                    onClick={() => goTo(index)}
                  >
                    <span className="wizard-step__index">{isDone ? '✓' : index + 1}</span>
                    <span className="wizard-step__label">
                      {wizardStep.label}
                      {wizardStep.optional ? <span className="muted"> (optional)</span> : null}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <div className="project-wizard__main">
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
            <div className="toolbar wizard-nav">
              <div className="wizard-nav__controls">
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
              <Link
                to={`/projects/${projectId}`}
                className="link-button wizard-exit"
                onClick={(event) => {
                  if (!stepDirty) return
                  event.preventDefault()
                  guardedNavigate(() => navigate(`/projects/${projectId}`))
                }}
              >
                Finish later
              </Link>
            </div>
          ) : (
            !projectId ? (
              <div className="toolbar wizard-nav">
                <Link to="/projects" className="link-button">Cancel</Link>
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
    </main>
  )
}
