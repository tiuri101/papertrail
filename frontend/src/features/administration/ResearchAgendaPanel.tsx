import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'

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
}: {
  number: string
  question: ResearchQuestion
  onSave: (text: string) => void
  onDelete: () => void
  pending: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(question.text)

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
            <input value={draft} onChange={(event) => setDraft(event.target.value)} required />
            <div className="toolbar">
              <button type="submit" disabled={pending}>Save</button>
              <button type="button" onClick={() => { setDraft(question.text); setEditing(false) }}>Cancel</button>
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
          <button type="button" onClick={() => setEditing(true)} disabled={pending}>Edit</button>
          <ConfirmButton
            label="Delete"
            warning="Delete this research question? This cannot be undone."
            onConfirm={onDelete}
            disabled={pending}
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
}: {
  number: string
  criterion: Criterion
  onSave: (kind: CriterionKind, text: string) => void
  onDelete: () => void
  pending: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draftKind, setDraftKind] = useState<CriterionKind>(criterion.kind)
  const [draftText, setDraftText] = useState(criterion.text)

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
              <select value={draftKind} onChange={(event) => setDraftKind(event.target.value as CriterionKind)}>
                <option value="inclusion">Inclusion</option>
                <option value="exclusion">Exclusion</option>
              </select>
            </label>
            <input value={draftText} onChange={(event) => setDraftText(event.target.value)} required />
            <div className="toolbar">
              <button type="submit" disabled={pending}>Save</button>
              <button
                type="button"
                onClick={() => { setDraftKind(criterion.kind); setDraftText(criterion.text); setEditing(false) }}
              >
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    )
  }

  return (
    <tr>
      <td>{number}</td>
      <td>{criterion.text}</td>
      <td>
        <div className="toolbar">
          <button type="button" onClick={() => setEditing(true)} disabled={pending}>Edit</button>
          <ConfirmButton
            label="Delete"
            warning="Delete this criterion? This cannot be undone."
            onConfirm={onDelete}
            disabled={pending}
          />
        </div>
      </td>
    </tr>
  )
}

export function ResearchAgendaPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [newQuestion, setNewQuestion] = useState('')
  const [newCriterionKind, setNewCriterionKind] = useState<CriterionKind>('inclusion')
  const [newCriterionText, setNewCriterionText] = useState('')

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
    onSuccess: () => { setNewQuestion(''); refresh() },
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

  const addCriterion = useMutation({
    mutationFn: () => apiRequest(`/api/v1/projects/${projectId}/criteria`, {
      method: 'POST',
      body: JSON.stringify({ kind: newCriterionKind, text: newCriterionText }),
    }),
    onSuccess: () => { setNewCriterionText(''); refresh() },
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

  const mutationError = addQuestion.error ?? updateQuestion.error ?? deleteQuestion.error
    ?? addCriterion.error ?? updateCriterion.error ?? deleteCriterion.error

  if (project.isLoading) return <p>Loading research agenda…</p>
  if (project.isError || !project.data) return <p className="error" role="alert">Research agenda could not be loaded.</p>

  const questionPending = updateQuestion.isPending || deleteQuestion.isPending
  const criterionPending = updateCriterion.isPending || deleteCriterion.isPending

  const inclusionCriteria = project.data.criteria
    .filter((criterion) => criterion.kind === 'inclusion')
    .map((criterion, index) => ({ criterion, number: `IC${index + 1}` }))
  const exclusionCriteria = project.data.criteria
    .filter((criterion) => criterion.kind === 'exclusion')
    .map((criterion, index) => ({ criterion, number: `EC${index + 1}` }))

  return (
    <>
      <section className="card">
        <h2>Research Questions</h2>
        {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
        <table>
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
              />
            ))}
          </tbody>
        </table>
        <form onSubmit={(event) => { event.preventDefault(); addQuestion.mutate() }}>
          <label>
            New research question
            <input
              value={newQuestion}
              onChange={(event) => setNewQuestion(event.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={addQuestion.isPending}>Add Research Question</button>
        </form>
      </section>

      <section className="card">
        <h2>Inclusion / Exclusion Criteria</h2>
        <table>
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
            {inclusionCriteria.length === 0 ? (
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
              />
            ))}
            <tr>
              <th colSpan={3}>Exclusion criteria</th>
            </tr>
            {exclusionCriteria.length === 0 ? (
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
              />
            ))}
          </tbody>
        </table>
        <form onSubmit={(event) => { event.preventDefault(); addCriterion.mutate() }}>
          <label>
            Kind
            <select
              value={newCriterionKind}
              onChange={(event) => setNewCriterionKind(event.target.value as CriterionKind)}
            >
              <option value="inclusion">Inclusion</option>
              <option value="exclusion">Exclusion</option>
            </select>
          </label>
          <label>
            New criterion
            <input
              value={newCriterionText}
              onChange={(event) => setNewCriterionText(event.target.value)}
              required
            />
          </label>
          <button type="submit" disabled={addCriterion.isPending}>Add Criterion</button>
        </form>
      </section>
    </>
  )
}
