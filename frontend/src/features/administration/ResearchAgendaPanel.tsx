import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button, IconButton } from '../../components/Button'
import { Card } from '../../components/Card'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconCheckCircle, IconHelpCircle, IconPlus, IconTrash } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'

type CriterionKind = 'inclusion' | 'exclusion'

interface ResearchQuestion {
  id: string
  text: string
}

interface Criterion {
  id: string
  kind: CriterionKind
  text: string
}

interface ProjectAgenda {
  id: string
  researchQuestions: ResearchQuestion[]
  criteria: Criterion[]
}

function ResearchQuestionRow({
  number,
  question,
  onSave,
  onDelete,
  pending,
  onDirtyChange,
}: {
  number: string
  question: ResearchQuestion
  onSave: (text: string) => void
  onDelete: () => void
  pending: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(question.text)

  useEffect(() => {
    onDirtyChange?.(editing && draft !== question.text)
  }, [editing, draft, question.text, onDirtyChange])

  if (editing) {
    return (
      <tr>
        <td colSpan={3}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              setEditing(false)
              onSave(draft)
            }}
          >
            <Input value={draft} onChange={(event) => setDraft(event.target.value)} required />
            <div className="toolbar">
              <Button type="submit" disabled={pending}><IconCheckCircle />Save</Button>
              <Button type="button" variant="secondary" onClick={() => { setDraft(question.text); setEditing(false) }}>Cancel</Button>
            </div>
          </form>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td>{number}</td>
      <td>{question.text}</td>
      <td>
        <div className="toolbar">
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={pending}>Edit</Button>
          <ConfirmButton
            label="Delete"
            warning="Delete this research question? This cannot be undone."
            onConfirm={onDelete}
            disabled={pending}
            variant="danger"
            icon={<IconTrash />}
            className="button-sm"
          />
        </div>
      </td>
    </tr>
  )
}

function CriterionRow({
  number,
  criterion,
  onSave,
  onDelete,
  pending,
  onDirtyChange,
}: {
  number: string
  criterion: Criterion
  onSave: (kind: CriterionKind, text: string) => void
  onDelete: () => void
  pending: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draftKind, setDraftKind] = useState<CriterionKind>(criterion.kind)
  const [draftText, setDraftText] = useState(criterion.text)

  useEffect(() => {
    onDirtyChange?.(editing && (draftKind !== criterion.kind || draftText !== criterion.text))
  }, [editing, draftKind, draftText, criterion.kind, criterion.text, onDirtyChange])

  if (editing) {
    return (
      <tr>
        <td colSpan={3}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              setEditing(false)
              onSave(draftKind, draftText)
            }}
          >
            <label>
              Kind
              <Select value={draftKind} onChange={(event) => setDraftKind(event.target.value as CriterionKind)}>
                <option value="inclusion">Inclusion</option>
                <option value="exclusion">Exclusion</option>
              </Select>
            </label>
            <Input value={draftText} onChange={(event) => setDraftText(event.target.value)} required />
            <div className="toolbar">
              <Button type="submit" disabled={pending}><IconCheckCircle />Save</Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => { setDraftKind(criterion.kind); setDraftText(criterion.text); setEditing(false) }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td>
        <span className={`criterion-badge criterion-badge--${criterion.kind}`}>{number}</span>
      </td>
      <td>{criterion.text}</td>
      <td>
        <div className="toolbar">
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)} disabled={pending}>Edit</Button>
          <ConfirmButton
            label="Delete"
            warning="Delete this criterion? This cannot be undone."
            onConfirm={onDelete}
            disabled={pending}
            variant="danger"
            icon={<IconTrash />}
            className="button-sm"
          />
        </div>
      </td>
    </tr>
  )
}

function InlineAgendaDraftRow({
  number,
  kind,
  label,
  value,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  number: string
  kind?: CriterionKind
  label: string
  value: string
  pending: boolean
  onChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <tr className="research-agenda-table__draft-row">
      <td>
        {kind ? <span className={`criterion-badge criterion-badge--${kind}`}>{number}</span> : number}
      </td>
      <td colSpan={2}>
        <form
          className="research-agenda-table__inline-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (value.trim()) onSave()
          }}
        >
          <label className="visually-hidden" htmlFor={`new-agenda-item-${kind ?? 'question'}`}>{label}</label>
          <Input
            id={`new-agenda-item-${kind ?? 'question'}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={label}
            autoFocus
            required
          />
          <div className="toolbar">
            <Button type="submit" size="sm" disabled={pending || !value.trim()}>
              <IconCheckCircle />Save
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      </td>
    </tr>
  )
}

export function ResearchQuestionsPanel({
  projectId,
  onDirtyChange,
  inlineAdd = false,
}: {
  projectId: string
  onDirtyChange?: (dirty: boolean) => void
  inlineAdd?: boolean
}) {
  const queryClient = useQueryClient()
  const [newQuestion, setNewQuestion] = useState('')
  const [addingQuestion, setAddingQuestion] = useState(false)
  const [dirtyRows, setDirtyRows] = useState<Record<string, boolean>>({})

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectAgenda>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] })

  const addQuestion = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/research-questions`, {
      method: 'POST',
      body: JSON.stringify({ text: newQuestion }),
    }),
    onSuccess: () => { setNewQuestion(''); setAddingQuestion(false); refresh() },
  })
  const updateQuestion = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      apiRequest(`/api/v1/projects/${projectId}/research-questions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ text }),
      }),
    onSuccess: refresh,
  })
  const deleteQuestion = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/projects/${projectId}/research-questions/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  })

  const mutationError = addQuestion.error ?? updateQuestion.error ?? deleteQuestion.error

  useEffect(() => {
    onDirtyChange?.(
      (inlineAdd ? addingQuestion : newQuestion.trim() !== '')
      || Object.values(dirtyRows).some(Boolean),
    )
  }, [addingQuestion, inlineAdd, newQuestion, dirtyRows, onDirtyChange])

  if (project.isLoading) return <p>Loading research questions…</p>
  if (project.isError || !project.data) return <p className="error" role="alert">Research questions could not be loaded.</p>

  const questionPending = updateQuestion.isPending || deleteQuestion.isPending

  return (
    <Card as="section" id="section-research-questions">
      <h2>
        <span className="collapsible-section__title">
          <span className="collapsible-section__icon" aria-hidden="true"><IconHelpCircle /></span>
          Research Questions
        </span>
      </h2>

      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      <table className="research-agenda-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Question</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {project.data.researchQuestions.map((question, index) => (
            <ResearchQuestionRow
              key={question.id}
              number={`RQ${index + 1}`}
              question={question}
              pending={questionPending}
              onSave={(text) => updateQuestion.mutate({ id: question.id, text })}
              onDelete={() => deleteQuestion.mutate(question.id)}
              onDirtyChange={(rowDirty) => setDirtyRows((current) => (
                current[question.id] === rowDirty ? current : { ...current, [question.id]: rowDirty }
              ))}
            />
          ))}
          {inlineAdd && addingQuestion ? (
            <InlineAgendaDraftRow
              number={`RQ${project.data.researchQuestions.length + 1}`}
              label="New research question"
              value={newQuestion}
              pending={addQuestion.isPending}
              onChange={setNewQuestion}
              onSave={() => addQuestion.mutate()}
              onCancel={() => { addQuestion.reset(); setNewQuestion(''); setAddingQuestion(false) }}
            />
          ) : null}
          {inlineAdd ? (
            <tr className="research-agenda-table__add-row">
              <td colSpan={3}>
                <IconButton
                  variant="secondary"
                  size="sm"
                  className="size-[30px]! min-w-[30px]! min-h-[30px]! rounded-full! [&_svg]:size-4!"
                  aria-label="Add research question"
                  title="Add research question"
                  onClick={() => { addQuestion.reset(); setNewQuestion(''); setAddingQuestion(true) }}
                  disabled={addingQuestion || addQuestion.isPending}
                >
                  <IconPlus />
                </IconButton>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {!inlineAdd ? (
        <>
          <hr className="section-divider" />
          <form onSubmit={(event) => { event.preventDefault(); addQuestion.mutate() }}>
            <label>
              New research question
              <Input
                value={newQuestion}
                onChange={(event) => setNewQuestion(event.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={addQuestion.isPending}><IconPlus />Add Research Question</button>
          </form>
        </>
      ) : null}
    </Card>
  )
}

export function CriteriaPanel({
  projectId,
  onDirtyChange,
  inlineAdd = false,
}: {
  projectId: string
  onDirtyChange?: (dirty: boolean) => void
  inlineAdd?: boolean
}) {
  const queryClient = useQueryClient()
  const [newCriterionKind, setNewCriterionKind] = useState<CriterionKind>('inclusion')
  const [newCriterionText, setNewCriterionText] = useState('')
  const [addingCriterionKind, setAddingCriterionKind] = useState<CriterionKind | null>(null)
  const [dirtyRows, setDirtyRows] = useState<Record<string, boolean>>({})

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectAgenda>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] })

  const addCriterion = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/criteria`, {
      method: 'POST',
      body: JSON.stringify({
        kind: inlineAdd ? addingCriterionKind : newCriterionKind,
        text: newCriterionText,
      }),
    }),
    onSuccess: () => { setNewCriterionText(''); setAddingCriterionKind(null); refresh() },
  })
  const updateCriterion = useMutation({
    mutationFn: ({ id, kind, text }: { id: string; kind: CriterionKind; text: string }) =>
      apiRequest(`/api/v1/projects/${projectId}/criteria/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ kind, text }),
      }),
    onSuccess: refresh,
  })
  const deleteCriterion = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/projects/${projectId}/criteria/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  })

  const mutationError = addCriterion.error ?? updateCriterion.error ?? deleteCriterion.error

  useEffect(() => {
    onDirtyChange?.(
      (inlineAdd ? addingCriterionKind !== null : newCriterionText.trim() !== '')
      || Object.values(dirtyRows).some(Boolean),
    )
  }, [addingCriterionKind, inlineAdd, newCriterionText, dirtyRows, onDirtyChange])

  if (project.isLoading) return <p>Loading criteria…</p>
  if (project.isError || !project.data) return <p className="error" role="alert">Criteria could not be loaded.</p>

  const criterionPending = updateCriterion.isPending || deleteCriterion.isPending

  const inclusionCriteria = project.data.criteria
    .filter((criterion) => criterion.kind === 'inclusion')
    .map((criterion, index) => ({ criterion, number: `IC${index + 1}` }))
  const exclusionCriteria = project.data.criteria
    .filter((criterion) => criterion.kind === 'exclusion')
    .map((criterion, index) => ({ criterion, number: `EC${index + 1}` }))

  return (
    <Card as="section" id="section-screening-criteria">
      <h2>
        <span className="collapsible-section__title">
          <span className="collapsible-section__icon" aria-hidden="true"><IconCheckCircle /></span>
          Inclusion / Exclusion Criteria
        </span>
      </h2>
      <InfoBox icon={<IconCheckCircle />}>
        <p>
          Every inclusion and exclusion criterion is shown during the screening phases. If LLM-support is
          enabled, these criteria are part of the context for LLM-based content generation.
        </p>
      </InfoBox>
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      <table className="research-agenda-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Criterion</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th colSpan={3}>Inclusion criteria</th>
          </tr>
          {inclusionCriteria.length === 0 && addingCriterionKind !== 'inclusion' ? (
            <tr>
              <td colSpan={3}>No inclusion criteria yet.</td>
            </tr>
          ) : null}
          {inclusionCriteria.map(({ criterion, number }) => (
            <CriterionRow
              key={criterion.id}
              number={number}
              criterion={criterion}
              pending={criterionPending}
              onSave={(kind, text) => updateCriterion.mutate({ id: criterion.id, kind, text })}
              onDelete={() => deleteCriterion.mutate(criterion.id)}
              onDirtyChange={(rowDirty) => setDirtyRows((current) => (
                current[criterion.id] === rowDirty ? current : { ...current, [criterion.id]: rowDirty }
              ))}
            />
          ))}
          {inlineAdd && addingCriterionKind === 'inclusion' ? (
            <InlineAgendaDraftRow
              number={`IC${inclusionCriteria.length + 1}`}
              kind="inclusion"
              label="New inclusion criterion"
              value={newCriterionText}
              pending={addCriterion.isPending}
              onChange={setNewCriterionText}
              onSave={() => addCriterion.mutate()}
              onCancel={() => { addCriterion.reset(); setNewCriterionText(''); setAddingCriterionKind(null) }}
            />
          ) : null}
          {inlineAdd ? (
            <tr className="research-agenda-table__add-row">
              <td colSpan={3}>
                <IconButton
                  variant="secondary"
                  size="sm"
                  className="size-[30px]! min-w-[30px]! min-h-[30px]! rounded-full! [&_svg]:size-4!"
                  aria-label="Add inclusion criterion"
                  title="Add inclusion criterion"
                  onClick={() => {
                    addCriterion.reset()
                    setNewCriterionText('')
                    setAddingCriterionKind('inclusion')
                  }}
                  disabled={addingCriterionKind !== null || addCriterion.isPending}
                >
                  <IconPlus />
                </IconButton>
              </td>
            </tr>
          ) : null}
          <tr>
            <th colSpan={3}>Exclusion criteria</th>
          </tr>
          {exclusionCriteria.length === 0 && addingCriterionKind !== 'exclusion' ? (
            <tr>
              <td colSpan={3}>No exclusion criteria yet.</td>
            </tr>
          ) : null}
          {exclusionCriteria.map(({ criterion, number }) => (
            <CriterionRow
              key={criterion.id}
              number={number}
              criterion={criterion}
              pending={criterionPending}
              onSave={(kind, text) => updateCriterion.mutate({ id: criterion.id, kind, text })}
              onDelete={() => deleteCriterion.mutate(criterion.id)}
              onDirtyChange={(rowDirty) => setDirtyRows((current) => (
                current[criterion.id] === rowDirty ? current : { ...current, [criterion.id]: rowDirty }
              ))}
            />
          ))}
          {inlineAdd && addingCriterionKind === 'exclusion' ? (
            <InlineAgendaDraftRow
              number={`EC${exclusionCriteria.length + 1}`}
              kind="exclusion"
              label="New exclusion criterion"
              value={newCriterionText}
              pending={addCriterion.isPending}
              onChange={setNewCriterionText}
              onSave={() => addCriterion.mutate()}
              onCancel={() => { addCriterion.reset(); setNewCriterionText(''); setAddingCriterionKind(null) }}
            />
          ) : null}
          {inlineAdd ? (
            <tr className="research-agenda-table__add-row">
              <td colSpan={3}>
                <IconButton
                  variant="secondary"
                  size="sm"
                  className="size-[30px]! min-w-[30px]! min-h-[30px]! rounded-full! [&_svg]:size-4!"
                  aria-label="Add exclusion criterion"
                  title="Add exclusion criterion"
                  onClick={() => {
                    addCriterion.reset()
                    setNewCriterionText('')
                    setAddingCriterionKind('exclusion')
                  }}
                  disabled={addingCriterionKind !== null || addCriterion.isPending}
                >
                  <IconPlus />
                </IconButton>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {!inlineAdd ? (
        <>
          <hr className="section-divider" />
          <form onSubmit={(event) => { event.preventDefault(); addCriterion.mutate() }}>
            <label>
              Kind
              <Select
                value={newCriterionKind}
                onChange={(event) => setNewCriterionKind(event.target.value as CriterionKind)}
              >
                <option value="inclusion">Inclusion</option>
                <option value="exclusion">Exclusion</option>
              </Select>
            </label>
            <label>
              New criterion
              <Input
                value={newCriterionText}
                onChange={(event) => setNewCriterionText(event.target.value)}
                required
              />
            </label>
            <button type="submit" disabled={addCriterion.isPending}><IconPlus />Add Criterion</button>
          </form>
        </>
      ) : null}
    </Card>
  )
}

export function ResearchAgendaPanel({ projectId }: { projectId: string }) {
  return (
    <>
      <ResearchQuestionsPanel projectId={projectId} inlineAdd />
      <CriteriaPanel projectId={projectId} inlineAdd />
    </>
  )
}
