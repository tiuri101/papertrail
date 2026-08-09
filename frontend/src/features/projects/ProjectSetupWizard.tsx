import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { CriteriaPanel, ResearchQuestionsPanel } from '../administration/ResearchAgendaPanel'
import { HighlightKeywordsPanel } from '../administration/HighlightKeywordsPanel'
import { MembersPanel } from '../administration/MembersPanel'
import { ScreeningConfigPanel } from '../administration/ScreeningConfigPanel'
import { FormFieldsPanel } from '../forms/FormFieldsPanel'
import { LlmAssistancePanel } from '../llm/LlmAssistancePanel'

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
      <h2>Project Name and Description</h2>
      <p className="muted">Give the project a clear name and a short description of its scope.</p>
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
          <button type="submit" disabled={pending || name.trim().length === 0}>
            {projectId ? 'Save & Continue' : 'Create Project & Continue'}
          </button>
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
  const projectId = routeProjectId ?? createdProjectId ?? ''
  const currentStepRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    currentStepRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'center' })
  }, [step])

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetails>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  const goTo = (index: number) => setStep(Math.max(0, Math.min(WIZARD_STEPS.length - 1, index)))
  const isLastStep = step === WIZARD_STEPS.length - 1

  const finish = () => navigate(`/projects/${projectId}`)

  return (
    <main className="page">
      <h1>Project Setup Wizard</h1>
      <p className="muted">
        {project.data?.name
          ? `Setting up "${project.data.name}". Every step but the first can be revisited later from the project's Administration page.`
          : 'Create a project by walking through each setup step. You can finish the rest later from the project\'s Administration page.'}
      </p>

      <div className="wizard-steps-wrap">
        <ol className="wizard-steps" aria-label="Project setup steps">
          {WIZARD_STEPS.map((wizardStep, index) => {
            const isCurrent = index === step
            const isDone = index < step
            const clickable = Boolean(projectId) || index === 0
            return (
              <li
                key={wizardStep.key}
                ref={isCurrent ? currentStepRef : undefined}
                className={
                  `wizard-step${isCurrent ? ' wizard-step--active' : ''}${isDone ? ' wizard-step--done' : ''}`
                }
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
      </div>

      {WIZARD_STEPS[step].key === 'details' ? (
        <ProjectDetailsStep
          projectId={projectId}
          onCreated={(id) => { setCreatedProjectId(id); goTo(1) }}
          onContinue={() => goTo(1)}
        />
      ) : null}
      {WIZARD_STEPS[step].key === 'questions' ? <ResearchQuestionsPanel projectId={projectId} /> : null}
      {WIZARD_STEPS[step].key === 'criteria' ? <CriteriaPanel projectId={projectId} /> : null}
      {WIZARD_STEPS[step].key === 'reviewers' ? (
        <>
          <p className="muted">
            Add the reviewers who will work on this project and choose which stages each one can take part in.
          </p>
          <MembersPanel projectId={projectId} />
        </>
      ) : null}
      {WIZARD_STEPS[step].key === 'screening' ? <ScreeningConfigPanel projectId={projectId} /> : null}
      {WIZARD_STEPS[step].key === 'extraction' ? (
        <FormFieldsPanel
          projectId={projectId}
          kind="extraction"
          title="Data Extraction Form"
          description="Define the fields reviewers will fill in when extracting data from included publications."
        />
      ) : null}
      {WIZARD_STEPS[step].key === 'quality' ? (
        <FormFieldsPanel
          projectId={projectId}
          kind="quality"
          title="Quality Assessment Form (optional)"
          description="Optionally define a form for assessing the methodological quality of included publications."
        />
      ) : null}
      {WIZARD_STEPS[step].key === 'keywords' ? <HighlightKeywordsPanel projectId={projectId} /> : null}
      {WIZARD_STEPS[step].key === 'llm' ? (
        <>
          <p className="muted">
            LLM assistance is optional. You can enable it now or come back to it later from the project&apos;s
            Administration page.
          </p>
          <LlmAssistancePanel projectId={projectId} showProcessingStatus={false} />
        </>
      ) : null}

      {WIZARD_STEPS[step].key !== 'details' ? (
        <div className="toolbar wizard-nav">
          <button type="button" className="button-secondary" onClick={() => goTo(step - 1)}>
            Back
          </button>
          {isLastStep ? (
            <button type="button" onClick={finish}>Finish Setup</button>
          ) : (
            <button type="button" onClick={() => goTo(step + 1)}>
              {WIZARD_STEPS[step].optional ? 'Skip / Next' : 'Next'}
            </button>
          )}
          <Link to={`/projects/${projectId}`} className="link-button wizard-exit">
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
    </main>
  )
}
