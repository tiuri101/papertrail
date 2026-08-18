import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { Button } from '../../components/Button'
import { IconCheckCircle, IconPlus, IconTrash } from '../../components/icons'
import { useRegisterSectionItems } from '../../components/sectionNavigation'
import { useProjectManageState } from '../../hooks/useCanManageProject'
import { useSession } from '../auth/sessionQuery'
import { StageEyebrow } from '../projects/StageEyebrow'
import { DynamicForm } from './DynamicForm'
import {
  buildScoring,
  describeRatingScale,
  fieldTypeLabels,
  fieldTypes,
  parseOptions,
  selectFieldTypes,
  weightedFieldTypes,
} from './fieldTypes'
import {InfoBox} from "../../components/InfoBox";

const formBuilderSections = [
  { id: 'section-create-form', label: 'Create Project Form' },
  { id: 'section-edit-form', label: 'Edit a Form' },
  { id: 'section-manage-templates', label: 'Manage Templates' },
]

interface ReviewForm {
  id: string
  name: string
  kind: string
  isTemplate: boolean
  activeVersionId: string | null
}

interface FormField {
  id: string
  stableKey: string
  label: string
  fieldType: string
  required: boolean
  position: number
  isArchived: boolean
  options: string[]
  scoring: Record<string, unknown>
}

export function FormBuilderPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const { canManage, isLoading: canManageLoading } = useProjectManageState(projectId)
  const session = useSession()
  const isAdmin = session.data?.user?.isAdmin ?? false
  useRegisterSectionItems(formBuilderSections)
  const [name, setName] = useState('Extraction form')
  const [kind, setKind] = useState('extraction')
  const [templateId, setTemplateId] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [selectedForm, setSelectedForm] = useState('')
  const [selectedFormName, setSelectedFormName] = useState('')
  const [fieldLabel, setFieldLabel] = useState('')
  const [fieldType, setFieldType] = useState('long_text')
  const [required, setRequired] = useState(false)
  const [optionsText, setOptionsText] = useState('')
  const [ratingMin, setRatingMin] = useState('1')
  const [ratingMax, setRatingMax] = useState('5')
  const [weight, setWeight] = useState('')
  const [optionScores, setOptionScores] = useState<Record<string, string>>({})
  const [trueScore, setTrueScore] = useState('')
  const [falseScore, setFalseScore] = useState('')

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [editingType, setEditingType] = useState('long_text')
  const [editingRequired, setEditingRequired] = useState(false)
  const [editingOptionsText, setEditingOptionsText] = useState('')
  const [editingRatingMin, setEditingRatingMin] = useState('1')
  const [editingRatingMax, setEditingRatingMax] = useState('5')
  const [editingWeight, setEditingWeight] = useState('')
  const [editingOptionScores, setEditingOptionScores] = useState<Record<string, string>>({})
  const [editingTrueScore, setEditingTrueScore] = useState('')
  const [editingFalseScore, setEditingFalseScore] = useState('')
  const [fieldOrder, setFieldOrder] = useState<string[]>([])
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, unknown>>({})

  const forms = useQuery({
    queryKey: ['forms', projectId],
    queryFn: () => apiRequest<ReviewForm[]>(
      `/api/v1/projects/${projectId}/forms`,
    ),
    enabled: canManage,
  })
  const templates = useQuery({
    queryKey: ['form-templates'],
    queryFn: () => apiRequest<ReviewForm[]>('/api/v1/form-templates'),
    enabled: canManage,
  })
  const fields = useQuery({
    queryKey: ['form-fields', selectedForm],
    queryFn: () => apiRequest<FormField[]>(
      `/api/v1/forms/${selectedForm}/fields`,
    ),
    enabled: Boolean(selectedForm) && canManage,
  })
  useEffect(() => {
    setFieldOrder(fields.data?.map((field) => field.stableKey) ?? [])
  }, [fields.data])
  const templateCatalog = templates.data?.filter((template) => template.isTemplate) ?? []
  const templatesForKind = templateCatalog.filter((template) => template.kind === kind)
  const existingFormOfKind = forms.data?.find((form) => !form.isTemplate && form.kind === kind)
  const selectedFormDefinition = [...(forms.data ?? []), ...templateCatalog]
    .find((form) => form.id === selectedForm)
  const isTemplateSelected = selectedFormDefinition?.isTemplate ?? false
  const selectedFormReadOnly = isTemplateSelected && !isAdmin

  useEffect(() => {
    setSelectedFormName(selectedFormDefinition?.name ?? '')
  }, [selectedFormDefinition?.name])

  const createForm = useMutation({
    mutationFn: () => apiRequest<ReviewForm>(
      `/api/v1/projects/${projectId}/forms`,
      {
        method: 'POST',
        body: JSON.stringify({ name, kind, templateId: templateId || undefined }),
      },
    ),
    onSuccess: (form) => {
      setSelectedForm(form.id)
      setTemplateId('')
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
    },
  })
  const deleteForm = useMutation({
    mutationFn: (formId: string) => apiRequest<void>(
      `/api/v1/forms/${formId}`,
      { method: 'DELETE' },
    ),
    onSuccess: (_data, formId) => {
      if (selectedForm === formId) setSelectedForm('')
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
      queryClient.invalidateQueries({ queryKey: ['form-templates'] })
    },
  })
  const renameForm = useMutation({
    mutationFn: () => apiRequest<ReviewForm>(`/api/v1/forms/${selectedForm}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: selectedFormName }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
      queryClient.invalidateQueries({ queryKey: ['form-templates'] })
    },
  })
  const selectedFormKind = selectedFormDefinition?.kind
  const isQualityForm = selectedFormKind === 'quality'
  const showOptions = selectFieldTypes.has(fieldType)
  const showRatingScale = fieldType === 'rating'
  const options = parseOptions(optionsText)
  const ratingOptions = [ratingMin, ratingMax]

  const addField = useMutation({
    mutationFn: () => apiRequest<FormField>(
      `/api/v1/forms/${selectedForm}/fields`,
      {
        method: 'POST',
        body: JSON.stringify({
          label: fieldLabel,
          fieldType,
          required,
          options: showOptions ? options : showRatingScale ? ratingOptions : [],
          scoring: buildScoring({ isQualityForm, fieldType, weight, options, optionScores, trueScore, falseScore }),
        }),
      },
    ),
    onSuccess: () => {
      setFieldLabel('')
      setOptionsText('')
      setRatingMin('1')
      setRatingMax('5')
      setWeight('')
      setOptionScores({})
      setTrueScore('')
      setFalseScore('')
      queryClient.invalidateQueries({
        queryKey: ['form-fields', selectedForm],
      })
    },
  })
  const updateField = useMutation({
    mutationFn: (variables: {
      stableKey: string
      label: string
      fieldType: string
      originalFieldType: string
      required: boolean
      position: number
      options: string[]
      scoring: Record<string, unknown>
    }) => {
      const typeChanged = variables.fieldType !== variables.originalFieldType
      return apiRequest<FormField>(
        typeChanged
          ? `/api/v1/forms/${selectedForm}/fields/${variables.stableKey}/replace`
          : `/api/v1/forms/${selectedForm}/fields/${variables.stableKey}`,
        {
          method: typeChanged ? 'POST' : 'PATCH',
          body: JSON.stringify({
            label: variables.label,
            ...(typeChanged ? { fieldType: variables.fieldType } : {}),
            required: variables.required,
            position: variables.position,
            options: variables.options,
            scoring: variables.scoring,
          }),
        },
      )
    },
    onSuccess: () => {
      setEditingKey(null)
      queryClient.invalidateQueries({ queryKey: ['form-fields', selectedForm] })
    },
  })
  const deleteField = useMutation({
    mutationFn: (stableKey: string) => apiRequest<FormField>(
      `/api/v1/forms/${selectedForm}/fields/${stableKey}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ archive: true }),
      },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['form-fields', selectedForm] }),
  })
  const saveAsTemplate = useMutation({
    mutationFn: () => apiRequest<ReviewForm>(
      `/api/v1/forms/${selectedForm}/save-as-template`,
      {
        method: 'POST',
        body: JSON.stringify({ name: templateName || undefined }),
      },
    ),
    onSuccess: () => {
      setTemplateName('')
      queryClient.invalidateQueries({ queryKey: ['form-templates'] })
    },
  })
  const beginEditingField = (field: FormField) => {
    const scoring = field.scoring ?? {}
    const scoreValues = typeof scoring.values === 'object' && scoring.values !== null
      ? scoring.values as Record<string, unknown>
      : {}
    setEditingKey(field.stableKey)
    setEditingLabel(field.label)
    setEditingType(field.fieldType)
    setEditingRequired(field.required)
    setEditingOptionsText(field.options.join('\n'))
    setEditingRatingMin(field.options[0] ?? '1')
    setEditingRatingMax(field.options[1] ?? '5')
    setEditingWeight(scoring.weight == null ? '' : String(scoring.weight))
    setEditingOptionScores(Object.fromEntries(
      Object.entries(scoreValues).map(([option, score]) => [option, String(score)]),
    ))
    setEditingTrueScore(scoring.true == null ? '' : String(scoring.true))
    setEditingFalseScore(scoring.false == null ? '' : String(scoring.false))
  }

  const moveEditingField = (offset: -1 | 1) => {
    if (!editingKey) return
    setFieldOrder((current) => {
      const index = current.indexOf(editingKey)
      const target = index + offset
      if (index < 0 || target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const orderedFields = [...(fields.data ?? [])].sort((left, right) => {
    const leftIndex = fieldOrder.indexOf(left.stableKey)
    const rightIndex = fieldOrder.indexOf(right.stableKey)
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
  })

  const mutationError = createForm.error ?? addField.error ?? updateField.error
    ?? deleteField.error ?? saveAsTemplate.error ?? deleteForm.error ?? renameForm.error
  const activeFields = orderedFields.filter((field) => !field.isArchived)

  if (canManageLoading) {
    return <main className="page"><p>Loading…</p></main>
  }
  if (!canManage) {
    return (
      <main className="page">
        <h1>Forms and Templates</h1>
        <p className="error" role="alert">
          Only the project owner or an administrator can manage forms and templates.
        </p>
      </main>
    )
  }

  return (
    <main className="page">
      <StageEyebrow stage="draft" />
      <h1>Forms and Templates</h1>
      <p className="muted">
        Build and manage this project's extraction and quality assessment forms, and save
        reusable field templates.
      </p>
      {forms.error ? <p className="error" role="alert">{forms.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      <section id="section-create-form" className="card">
        <h2>Create Project Form</h2>
        <InfoBox icon={<IconCheckCircle />}>
          <p>
            Each project has one extraction form and one (optional) quality form. These forms are show to the reviewers
            during screening and data extraction.
          </p>
        </InfoBox>
        <label>
          Kind
          <select
            value={kind}
            onChange={(event) => { setKind(event.target.value); setTemplateId('') }}
          >
            <option value="extraction">Extraction</option>
            <option value="quality">Quality assessment</option>
          </select>
        </label>
        {existingFormOfKind ? (
          <div className="form-editor-existing-form">
            <p>
              This project already has {kind === 'quality' ? 'a quality assessment' : 'an extraction'} form:{' '}
              <strong>{existingFormOfKind.name}</strong>.
            </p>
            <div className="toolbar form-editor-existing-form__actions">
              <button type="button" onClick={() => setSelectedForm(existingFormOfKind.id)}>
                Edit It Below
              </button>
              <ConfirmButton
                label="Remove It"
                confirmLabel="Remove Form"
                warning={`Remove the "${existingFormOfKind.name}" form? This can't be undone, but you can create a new one (optionally from a template) right after.`}
                onConfirm={() => deleteForm.mutate(existingFormOfKind.id)}
                disabled={deleteForm.isPending}
                variant="danger"
                icon={<IconTrash />}
              />
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); createForm.mutate() }}>
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              Start from template (optional)
              <select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                <option value="">From scratch</option>
                {templatesForKind.map((template) => (
                  <option key={template.id} value={template.id}>{template.name}</option>
                ))}
              </select>
            </label>
            {templates.error ? <p className="error" role="alert">{templates.error.message}</p> : null}
            <Button type="submit" variant="primary" loading={createForm.isPending}><IconPlus />Create Form</Button>
          </form>
        )}
      </section>
      <section id="section-edit-form" className="card">
        <h2>Inspect or Edit a Form</h2>
        <label>
          Form to edit
          <select
            value={selectedForm}
            onChange={(event) => setSelectedForm(event.target.value)}
          >
            <option value="">Select a form or template</option>
            <optgroup label="Project forms">
              {forms.data?.map((form) => (
                <option key={form.id} value={form.id}>
                  {form.name} ({form.kind})
                </option>
              ))}
            </optgroup>
            <optgroup label="Reusable templates">
              {templateCatalog.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name} ({template.kind})
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        {selectedForm ? (
          <>
            <div className="form-editor-selection-heading">
              <div>
                <span className="form-editor-selection-type">
                  {isTemplateSelected ? 'Reusable template' : 'Project form'}
                </span>
                {selectedFormReadOnly ? <h3>{selectedFormDefinition?.name}</h3> : null}
              </div>
              {!selectedFormReadOnly ? (
                <form
                  className="form-editor-rename"
                  onSubmit={(event) => { event.preventDefault(); renameForm.mutate() }}
                >
                  <label>
                    Name
                    <input
                      value={selectedFormName}
                      onChange={(event) => setSelectedFormName(event.target.value)}
                      required
                    />
                  </label>
                  <Button type="submit" variant="secondary" loading={renameForm.isPending}>
                    Save Name
                  </Button>
                </form>
              ) : null}
            </div>
            {selectedFormReadOnly ? (
              <p className="muted">Templates are read-only unless you are an installation administrator.</p>
            ) : null}
            {!selectedFormReadOnly ? (
            <>
            <h3>Add Field</h3>
            <form onSubmit={(event) => { event.preventDefault(); addField.mutate() }}>
              <label>
                Label
                <input
                  value={fieldLabel}
                  onChange={(event) => setFieldLabel(event.target.value)}
                  required
                />
              </label>
              <label>
                Type
                <select
                  value={fieldType}
                  onChange={(event) => setFieldType(event.target.value)}
                >
                  {fieldTypes.map((type) => (
                    <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(event) => setRequired(event.target.checked)}
                />
                Required
              </label>
              {showOptions ? (
                <label>
                  Options (one per line)
                  <textarea
                    value={optionsText}
                    onChange={(event) => setOptionsText(event.target.value)}
                    rows={4}
                  />
                </label>
              ) : null}
              {showRatingScale ? (
                <>
                  <label>
                    Scale minimum
                    <input
                      type="number"
                      value={ratingMin}
                      onChange={(event) => setRatingMin(event.target.value)}
                    />
                  </label>
                  <label>
                    Scale maximum
                    <input
                      type="number"
                      value={ratingMax}
                      onChange={(event) => setRatingMax(event.target.value)}
                    />
                  </label>
                </>
              ) : null}
              {isQualityForm && weightedFieldTypes.has(fieldType) ? (
                <label>
                  Score weight
                  <input
                    type="number"
                    value={weight}
                    onChange={(event) => setWeight(event.target.value)}
                  />
                </label>
              ) : null}
              {isQualityForm && fieldType === 'single_select' ? (
                <fieldset>
                  <legend>Score per option</legend>
                  {options.length === 0 ? <p className="muted">Add options above first.</p> : null}
                  {options.map((option) => (
                    <label key={option}>
                      {option}
                      <input
                        type="number"
                        value={optionScores[option] ?? ''}
                        onChange={(event) => setOptionScores((current) => ({ ...current, [option]: event.target.value }))}
                      />
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {isQualityForm && fieldType === 'checkbox' ? (
                <>
                  <label>
                    Score if checked
                    <input type="number" value={trueScore} onChange={(event) => setTrueScore(event.target.value)} />
                  </label>
                  <label>
                    Score if unchecked
                    <input type="number" value={falseScore} onChange={(event) => setFalseScore(event.target.value)} />
                  </label>
                </>
              ) : null}
              <Button type="submit" variant="primary" loading={addField.isPending}><IconPlus />Add Field</Button>
            </form>
            </>
            ) : null}
            <h3>Fields</h3>
            {fields.error ? <p className="error" role="alert">{fields.error.message}</p> : null}
            {fields.data?.length === 0 ? <p className="muted">No fields added yet.</p> : (
              <div className="llm-schema-fields form-editor-fields">
                {orderedFields.map((field) => {
                  const editingOptions = parseOptions(editingOptionsText)
                  const editingIndex = fieldOrder.indexOf(field.stableKey)
                  return (
                  <details
                    className="llm-schema-field form-editor-field"
                    key={field.id}
                    open={field.isArchived ? undefined : editingKey === field.stableKey}
                  >
                    <summary
                      className="llm-schema-field__summary"
                      onClick={(event) => {
                        if (field.isArchived) return
                        if (selectedFormReadOnly) return
                        event.preventDefault()
                        if (editingKey !== field.stableKey) beginEditingField(field)
                      }}
                    >
                      <span className="llm-schema-field__title">
                        <strong>{field.label}</strong>
                        <span className="status-badge">
                          {fieldTypeLabels[field.fieldType] ?? field.fieldType}
                          {field.fieldType === 'rating' ? ` (${describeRatingScale(field.options)})` : ''}
                        </span>
                        {field.required ? <span className="status-badge">Required</span> : null}
                        {field.isArchived ? <span className="status-badge">Archived</span> : null}
                      </span>
                      <span className="llm-schema-field__mapping">
                        {field.isArchived
                          ? 'Archived field retained for historical submissions'
                          : field.required ? 'Reviewers must complete this field' : 'Optional for reviewers'}
                      </span>
                      <span className="llm-schema-field__preview">
                        {field.fieldType === 'rating'
                          ? `Rating scale ${describeRatingScale(field.options)}`
                          : selectFieldTypes.has(field.fieldType)
                            ? field.options.length ? `Options: ${field.options.join(', ')}` : 'No options configured.'
                            : `${fieldTypeLabels[field.fieldType] ?? field.fieldType} response field`}
                      </span>
                    </summary>
                    <div className="llm-schema-field__content">
                      {editingKey === field.stableKey ? (
                        <>
                          <label>
                            Label
                            <input
                              aria-label={`Edit label for ${field.label}`}
                              value={editingLabel}
                              onChange={(event) => setEditingLabel(event.target.value)}
                            />
                          </label>
                          <label>
                            Type
                            <select
                              aria-label={`Edit type for ${field.label}`}
                              value={editingType}
                              onChange={(event) => setEditingType(event.target.value)}
                            >
                              {fieldTypes.map((type) => (
                                <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              aria-label={`Edit required for ${field.label}`}
                              checked={editingRequired}
                              onChange={(event) => setEditingRequired(event.target.checked)}
                            />
                            Required
                          </label>
                          {selectFieldTypes.has(editingType) ? (
                            <label>
                              Options (one per line)
                              <textarea
                                aria-label={`Edit options for ${field.label}`}
                                value={editingOptionsText}
                                onChange={(event) => setEditingOptionsText(event.target.value)}
                                rows={4}
                              />
                            </label>
                          ) : null}
                          {editingType === 'rating' ? (
                            <div className="form-editor-field__settings-row">
                              <label>
                                Scale minimum
                                <input
                                  type="number"
                                  aria-label={`Edit scale minimum for ${field.label}`}
                                  value={editingRatingMin}
                                  onChange={(event) => setEditingRatingMin(event.target.value)}
                                />
                              </label>
                              <label>
                                Scale maximum
                                <input
                                  type="number"
                                  aria-label={`Edit scale maximum for ${field.label}`}
                                  value={editingRatingMax}
                                  onChange={(event) => setEditingRatingMax(event.target.value)}
                                />
                              </label>
                            </div>
                          ) : null}
                          {isQualityForm && weightedFieldTypes.has(editingType) ? (
                            <label>
                              Score weight
                              <input
                                type="number"
                                aria-label={`Edit score weight for ${field.label}`}
                                value={editingWeight}
                                onChange={(event) => setEditingWeight(event.target.value)}
                              />
                            </label>
                          ) : null}
                          {isQualityForm && editingType === 'single_select' ? (
                            <fieldset>
                              <legend>Score per option</legend>
                              {editingOptions.length === 0 ? <p className="muted">Add options above first.</p> : null}
                              {editingOptions.map((option) => (
                                <label key={option}>
                                  {option}
                                  <input
                                    type="number"
                                    aria-label={`Edit score for ${option}`}
                                    value={editingOptionScores[option] ?? ''}
                                    onChange={(event) => setEditingOptionScores((current) => ({
                                      ...current,
                                      [option]: event.target.value,
                                    }))}
                                  />
                                </label>
                              ))}
                            </fieldset>
                          ) : null}
                          {isQualityForm && editingType === 'checkbox' ? (
                            <div className="form-editor-field__settings-row">
                              <label>
                                Score if checked
                                <input
                                  type="number"
                                  aria-label={`Edit checked score for ${field.label}`}
                                  value={editingTrueScore}
                                  onChange={(event) => setEditingTrueScore(event.target.value)}
                                />
                              </label>
                              <label>
                                Score if unchecked
                                <input
                                  type="number"
                                  aria-label={`Edit unchecked score for ${field.label}`}
                                  value={editingFalseScore}
                                  onChange={(event) => setEditingFalseScore(event.target.value)}
                                />
                              </label>
                            </div>
                          ) : null}
                          <div className="toolbar">
                            <button
                              type="button"
                              className="button-secondary"
                              disabled={editingIndex <= 0}
                              onClick={() => moveEditingField(-1)}
                            >
                              Move Up
                            </button>
                            <button
                              type="button"
                              className="button-secondary"
                              disabled={editingIndex < 0 || editingIndex === fieldOrder.length - 1}
                              onClick={() => moveEditingField(1)}
                            >
                              Move Down
                            </button>
                            <button
                              type="button"
                              disabled={updateField.isPending}
                              onClick={() => {
                                const nextOptions = selectFieldTypes.has(editingType)
                                  ? editingOptions
                                  : editingType === 'rating' ? [editingRatingMin, editingRatingMax] : []
                                updateField.mutate({
                                  stableKey: field.stableKey,
                                  label: editingLabel,
                                  fieldType: editingType,
                                  originalFieldType: field.fieldType,
                                  required: editingRequired,
                                  position: fieldOrder.indexOf(field.stableKey),
                                  options: nextOptions,
                                  scoring: buildScoring({
                                    isQualityForm,
                                    fieldType: editingType,
                                    weight: editingWeight,
                                    options: nextOptions,
                                    optionScores: editingOptionScores,
                                    trueScore: editingTrueScore,
                                    falseScore: editingFalseScore,
                                  }),
                                })
                              }}
                            >
                              <IconCheckCircle />
                              Save
                            </button>
                            <button
                              type="button"
                              className="button-secondary"
                              onClick={() => {
                                setEditingKey(null)
                                setFieldOrder(fields.data?.map((item) => item.stableKey) ?? [])
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </>
                      ) : field.isArchived ? (
                        <p className="muted">
                          This field is no longer shown on new submissions. Previously recorded values are preserved.
                        </p>
                      ) : null}
                      {!field.isArchived && editingKey === field.stableKey ? (
                        <ConfirmButton
                          label="Archive"
                          confirmLabel="Archive Field"
                          warning={`Archive field "${field.label}"? It will be removed from new submissions, but every value already recorded for it is kept and can still be included in exports.`}
                          onConfirm={() => deleteField.mutate(field.stableKey)}
                          disabled={deleteField.isPending}
                          variant="danger"
                        />
                      ) : null}
                    </div>
                  </details>
                  )
                })}
              </div>
            )}
            {!isTemplateSelected ? (
            <>
            <h3>Save as Reusable Template</h3>
            <p className="muted">Saves the current fields as a new template. Later edits to this project form won't affect the template, or vice versa.</p>
            <form onSubmit={(event) => { event.preventDefault(); saveAsTemplate.mutate() }}>
              <label>
                Template name
                <input
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder={forms.data?.find((form) => form.id === selectedForm)?.name ?? ''}
                />
              </label>
              {saveAsTemplate.isSuccess ? <p>Template saved.</p> : null}
              <Button type="submit" variant="secondary" loading={saveAsTemplate.isPending}><IconCheckCircle />Save as Template</Button>
            </form>
            </>
            ) : null}
            {activeFields.length ? (
              <>
                <h3>Preview</h3>
                <div className="card">
                  <DynamicForm
                    fields={activeFields.map((field) => ({
                      stableKey: field.stableKey,
                      label: field.label,
                      fieldType: field.fieldType,
                      required: field.required,
                      options: field.options,
                    }))}
                    value={previewAnswers}
                    onChange={(key, value) => setPreviewAnswers((current) => ({ ...current, [key]: value }))}
                  />
                </div>
              </>
            ) : null}
          </>
        ) : null}
      </section>
      <section id="section-manage-templates" className="card form-template-manager">
        <div className="form-template-manager__heading">
          <div>
            <h2>Manage Templates</h2>
          </div>
          <span className="status-badge">
            {templateCatalog.length} template{templateCatalog.length === 1 ? '' : 's'}
          </span>
        </div>
        {templates.error ? <p className="error" role="alert">{templates.error.message}</p> : null}
        {templates.isLoading ? <p className="muted">Loading templates…</p> : null}
        {templateCatalog.length === 0 ? (
          <div className="empty-state form-template-manager__empty">
            <h3>No reusable templates yet</h3>
            <p>Open a project form above and save it as a template to build your catalog.</p>
          </div>
        ) : (
          <ul className="form-template-grid" aria-label="Form templates">
            {templateCatalog.map((template) => (
              <li className="form-template-card" key={template.id}>
                <div>
                  <span className="form-template-card__kind">
                    {template.kind === 'quality' ? 'Quality assessment' : 'Extraction'}
                  </span>
                  <h3>{template.name}</h3>
                </div>
                <div className="toolbar form-template-card__actions">
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => setSelectedForm(template.id)}
                  >
                    {isAdmin ? 'Inspect & Edit' : 'Inspect'}
                  </button>
                  {isAdmin ? (
                    <ConfirmButton
                      label="Remove"
                      confirmLabel="Remove Template"
                      warning={`Remove the "${template.name}" template? Existing project forms created from it won't be affected.`}
                      onConfirm={() => deleteForm.mutate(template.id)}
                      disabled={deleteForm.isPending}
                      variant="danger"
                      icon={<IconTrash />}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
