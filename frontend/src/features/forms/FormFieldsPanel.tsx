import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { IconCheckCircle, IconPlus, IconTrash } from '../../components/icons'
import { DynamicForm } from './DynamicForm'
import {
  buildScoring,
  fieldTypeLabels,
  fieldTypes,
  parseOptions,
  selectFieldTypes,
  weightedFieldTypes,
} from './fieldTypes'

type FormKind = 'extraction' | 'quality'

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
  isArchived: boolean
  options: string[]
}

interface QualityConfig {
  enabled: boolean
  mode: string
  aggregation: string
}

export function FormFieldsPanel({
  projectId,
  kind,
  title,
  description,
}: {
  projectId: string
  kind: FormKind
  title: string
  description?: string
}) {
  const queryClient = useQueryClient()
  const isQualityForm = kind === 'quality'
  const [name, setName] = useState(kind === 'quality' ? 'Quality assessment form' : 'Extraction form')
  const [templateId, setTemplateId] = useState('')
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
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, unknown>>({})

  const [qcEnabled, setQcEnabled] = useState(false)
  const [qcMode, setQcMode] = useState('both')
  const [qcAggregation, setQcAggregation] = useState('sum')

  const forms = useQuery({
    queryKey: ['forms', projectId],
    queryFn: () => apiRequest<ReviewForm[]>(`/api/v1/projects/${projectId}/forms`),
    enabled: Boolean(projectId),
  })
  const templates = useQuery({
    queryKey: ['form-templates'],
    queryFn: () => apiRequest<ReviewForm[]>('/api/v1/form-templates'),
    enabled: Boolean(projectId),
  })
  const existingForm = forms.data?.find((form) => !form.isTemplate && form.kind === kind)
  const fields = useQuery({
    queryKey: ['form-fields', existingForm?.id],
    queryFn: () => apiRequest<FormField[]>(`/api/v1/forms/${existingForm?.id}/fields`),
    enabled: Boolean(existingForm),
  })
  const qualityConfig = useQuery({
    queryKey: ['quality-config', projectId],
    queryFn: () => apiRequest<QualityConfig>(`/api/v1/projects/${projectId}/quality-config`),
    enabled: Boolean(projectId) && isQualityForm,
  })
  const qualityConfigSeeded = useRef(false)
  useEffect(() => {
    if (qualityConfig.data && !qualityConfigSeeded.current) {
      qualityConfigSeeded.current = true
      setQcEnabled(qualityConfig.data.enabled ?? false)
      setQcMode(qualityConfig.data.mode ?? 'both')
      setQcAggregation(qualityConfig.data.aggregation ?? 'sum')
    }
  }, [qualityConfig.data])

  const templatesForKind = templates.data?.filter((template) => template.kind === kind) ?? []
  const showOptions = selectFieldTypes.has(fieldType)
  const showRatingScale = fieldType === 'rating'
  const options = parseOptions(optionsText)
  const ratingOptions = [ratingMin, ratingMax]

  const createForm = useMutation({
    mutationFn: () => apiRequest<ReviewForm>(`/api/v1/projects/${projectId}/forms`, {
      method: 'POST',
      body: JSON.stringify({ name, kind, templateId: templateId || undefined }),
    }),
    onSuccess: () => {
      setTemplateId('')
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
    },
  })
  const addField = useMutation({
    mutationFn: () => apiRequest<FormField>(`/api/v1/forms/${existingForm?.id}/fields`, {
      method: 'POST',
      body: JSON.stringify({
        label: fieldLabel,
        fieldType,
        required,
        options: showOptions ? options : showRatingScale ? ratingOptions : [],
        scoring: buildScoring({ isQualityForm, fieldType, weight, options, optionScores, trueScore, falseScore }),
      }),
    }),
    onSuccess: () => {
      setFieldLabel('')
      setOptionsText('')
      setRatingMin('1')
      setRatingMax('5')
      setWeight('')
      setOptionScores({})
      setTrueScore('')
      setFalseScore('')
      queryClient.invalidateQueries({ queryKey: ['form-fields', existingForm?.id] })
    },
  })
  const updateField = useMutation({
    mutationFn: (variables: { stableKey: string; label: string; fieldType: string; required: boolean }) => apiRequest<FormField>(
      `/api/v1/forms/${existingForm?.id}/fields/${variables.stableKey}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ label: variables.label, fieldType: variables.fieldType, required: variables.required }),
      },
    ),
    onSuccess: () => {
      setEditingKey(null)
      queryClient.invalidateQueries({ queryKey: ['form-fields', existingForm?.id] })
    },
  })
  const removeField = useMutation({
    mutationFn: (stableKey: string) => apiRequest<void>(
      `/api/v1/forms/${existingForm?.id}/fields/${stableKey}`,
      { method: 'DELETE' },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['form-fields', existingForm?.id] }),
  })
  const saveQualityConfig = useMutation({
    mutationFn: (next: { enabled: boolean; mode: string; aggregation: string }) => apiRequest(
      `/api/v1/projects/${projectId}/quality-config`,
      { method: 'PUT', body: JSON.stringify(next) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quality-config', projectId] }),
  })
  const updateQualityConfig = (next: { enabled: boolean; mode: string; aggregation: string }) => {
    setQcEnabled(next.enabled)
    setQcMode(next.mode)
    setQcAggregation(next.aggregation)
    if (qualityConfigSeeded.current) saveQualityConfig.mutate(next)
  }

  const mutationError = createForm.error ?? addField.error ?? updateField.error ?? removeField.error
  const activeFields = fields.data?.filter((field) => !field.isArchived) ?? []

  return (
    <section className="card">
      <h2>{title}</h2>
      {description ? <p className="muted">{description}</p> : null}
      {forms.error ? <p className="error" role="alert">{forms.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}

      {isQualityForm ? (
        <div>
          <label>
            <input
              type="checkbox"
              checked={qcEnabled}
              onChange={(event) => updateQualityConfig({ enabled: event.target.checked, mode: qcMode, aggregation: qcAggregation })}
            />
            Enable quality assessment
          </label>
          <label>
            Mode
            <select
              value={qcMode}
              onChange={(event) => updateQualityConfig({ enabled: qcEnabled, mode: event.target.value, aggregation: qcAggregation })}
            >
              <option value="qualitative">Qualitative only</option>
              <option value="numeric">Numerical scoring only</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label>
            Aggregation
            <select
              value={qcAggregation}
              onChange={(event) => updateQualityConfig({ enabled: qcEnabled, mode: qcMode, aggregation: event.target.value })}
            >
              <option value="sum">Simple sum</option>
              <option value="average">Average</option>
              <option value="weighted_average">Weighted average</option>
            </select>
          </label>
          {saveQualityConfig.error ? <p className="error" role="alert">{saveQualityConfig.error.message}</p> : null}
          <p className="muted" aria-live="polite">
            {saveQualityConfig.isPending ? 'Saving…' : saveQualityConfig.isSuccess ? 'Saved.' : ' '}
          </p>
        </div>
      ) : null}

      {!existingForm ? (
        <form onSubmit={(event) => { event.preventDefault(); createForm.mutate() }}>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
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
          <button type="submit" disabled={createForm.isPending}>
            <IconPlus />
            Create {isQualityForm ? 'Quality' : 'Extraction'} Form
          </button>
        </form>
      ) : (
        <>
          <h3>Add Field</h3>
          <form onSubmit={(event) => { event.preventDefault(); addField.mutate() }}>
            <label>
              Label
              <input value={fieldLabel} onChange={(event) => setFieldLabel(event.target.value)} required />
            </label>
            <label>
              Type
              <select value={fieldType} onChange={(event) => setFieldType(event.target.value)}>
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
                  <input type="number" value={ratingMin} onChange={(event) => setRatingMin(event.target.value)} />
                </label>
                <label>
                  Scale maximum
                  <input type="number" value={ratingMax} onChange={(event) => setRatingMax(event.target.value)} />
                </label>
              </>
            ) : null}
            {isQualityForm && weightedFieldTypes.has(fieldType) ? (
              <label>
                Score weight
                <input type="number" value={weight} onChange={(event) => setWeight(event.target.value)} />
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
            <button type="submit" disabled={addField.isPending}><IconPlus />Add Field</button>
          </form>

          <h3>Fields</h3>
          {fields.error ? <p className="error" role="alert">{fields.error.message}</p> : null}
          {activeFields.length === 0 ? <p className="muted">No fields added yet.</p> : (
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeFields.map((field) => (
                  <tr key={field.id}>
                    <td>
                      {editingKey === field.stableKey ? (
                        <input
                          aria-label={`Edit label for ${field.label}`}
                          value={editingLabel}
                          onChange={(event) => setEditingLabel(event.target.value)}
                        />
                      ) : field.label}
                    </td>
                    <td>
                      {editingKey === field.stableKey ? (
                        <select
                          aria-label={`Edit type for ${field.label}`}
                          value={editingType}
                          onChange={(event) => setEditingType(event.target.value)}
                        >
                          {fieldTypes.map((type) => (
                            <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
                          ))}
                        </select>
                      ) : (fieldTypeLabels[field.fieldType] ?? field.fieldType)}
                    </td>
                    <td>
                      {editingKey === field.stableKey ? (
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`Edit required for ${field.label}`}
                            checked={editingRequired}
                            onChange={(event) => setEditingRequired(event.target.checked)}
                          />
                          Required
                        </label>
                      ) : (field.required ? 'Required' : '—')}
                    </td>
                    <td>
                      {editingKey === field.stableKey ? (
                        <div className="toolbar">
                          <button
                            type="button"
                            disabled={updateField.isPending}
                            onClick={() => updateField.mutate({
                              stableKey: field.stableKey,
                              label: editingLabel,
                              fieldType: editingType,
                              required: editingRequired,
                            })}
                          >
                            <IconCheckCircle />
                            Save
                          </button>
                          <button type="button" className="button-secondary" onClick={() => setEditingKey(null)}>Cancel</button>
                        </div>
                      ) : (
                        <div className="toolbar">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingKey(field.stableKey)
                              setEditingLabel(field.label)
                              setEditingType(field.fieldType)
                              setEditingRequired(field.required)
                            }}
                          >
                            Edit
                          </button>
                          <ConfirmButton
                            label="Remove"
                            confirmLabel="Remove Field"
                            warning={`Remove field "${field.label}"? This can't be undone.`}
                            onConfirm={() => removeField.mutate(field.stableKey)}
                            disabled={removeField.isPending}
                            variant="danger"
                            icon={<IconTrash />}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

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
      )}
    </section>
  )
}
