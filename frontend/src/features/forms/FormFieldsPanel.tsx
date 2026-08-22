import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import { Button } from '../../components/Button'
import { DragHandle } from '../../components/DragHandle'
import { IconCheckCircle, IconDownload, IconPlus, IconTrash } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import type { QualityConfig } from '../quality/types'
import { DynamicForm } from './DynamicForm'
import { FieldEditForm } from './FieldEditForm'
import {
  buildScoring,
  describeRatingScale,
  fieldTypeLabels,
  fieldTypes,
  parseOptions,
  selectFieldTypes,
  weightedFieldTypes,
} from './fieldTypes'
import { NewFieldDraftCard } from './NewFieldDraftCard'
import type { FormField, ReviewForm } from './types'
import { useFormFieldEditor } from './useFormFieldEditor'

type FormKind = 'extraction' | 'quality'

type TaskAllocationMode = QualityConfig['allocationMode']

const TASK_ALLOCATION_MODE_LABELS: Record<TaskAllocationMode, string> = {
  claim: 'Claim (reviewers pick up publications themselves)',
  pre_assigned: 'Pre-assigned (publications are split across reviewers)',
}

interface ExtractionConfig {
  allocationMode: TaskAllocationMode
}

export function FormFieldsPanel({
  projectId,
  kind,
  title,
  description,
  inlineAdd = false,
  onDirtyChange,
}: {
  projectId: string
  kind: FormKind
  title: string
  description?: string
  inlineAdd?: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const queryClient = useQueryClient()
  const isQualityForm = kind === 'quality'
  const [name, setName] = useState(kind === 'quality' ? 'Quality assessment form' : 'Extraction form')
  const [templateId, setTemplateId] = useState('')
  const deletingEmptyFormIdRef = useRef<string | null>(null)

  const [qcEnabled, setQcEnabled] = useState(false)
  const [qcMode, setQcMode] = useState('both')
  const [qcAggregation, setQcAggregation] = useState('sum')
  const [qcAllocationMode, setQcAllocationMode] = useState<TaskAllocationMode>('claim')
  const [extractionAllocationMode, setExtractionAllocationMode] = useState<TaskAllocationMode>('claim')

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
  const deleteEmptyForm = useMutation({
    mutationFn: (formId: string) => apiRequest<void>(
      `/api/v1/forms/${formId}`,
      { method: 'DELETE' },
    ),
    onSuccess: (_data, formId) => {
      queryClient.setQueryData<ReviewForm[]>(['forms', projectId], (current = []) => (
        current.filter((form) => form.id !== formId)
      ))
      queryClient.removeQueries({ queryKey: ['form-fields', formId] })
      deletingEmptyFormIdRef.current = null
    },
  })

  const saveFieldOrder = useMutation({
    mutationFn: ({ stableKey, position }: { stableKey: string; position: number }) => apiRequest<FormField>(
      `/api/v1/forms/${existingForm?.id}/fields/${stableKey}`,
      { method: 'PATCH', body: JSON.stringify({ position }) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['form-fields', existingForm?.id] }),
    onError: () => queryClient.invalidateQueries({ queryKey: ['form-fields', existingForm?.id] }),
  })

  const {
    fieldLabel, setFieldLabel, fieldType, setFieldType, required, setRequired,
    optionsText, setOptionsText, ratingMin, setRatingMin, ratingMax, setRatingMax,
    weight, setWeight, optionScores, setOptionScores, trueScore, setTrueScore,
    falseScore, setFalseScore, addingField, setAddingField,
    editingKey, setEditingKey, editingLabel, setEditingLabel, editingType, setEditingType,
    editingRequired, setEditingRequired, editingOptionsText, setEditingOptionsText,
    editingRatingMin, setEditingRatingMin, editingRatingMax, setEditingRatingMax,
    editingWeight, setEditingWeight, editingOptionScores, setEditingOptionScores,
    editingTrueScore, setEditingTrueScore, editingFalseScore, setEditingFalseScore,
    fieldOrder, draggedFieldKey, setDraggedFieldKey, dragOverFieldKey, setDragOverFieldKey,
    previewAnswers, setPreviewAnswers,
    beginEditingField, moveFieldTo, orderedFields, resetNewField, cancelEditing,
  } = useFormFieldEditor(
    fields.data,
    (stableKey, position) => saveFieldOrder.mutate({ stableKey, position }),
  )

  useEffect(() => {
    onDirtyChange?.(inlineAdd && addingField)
  }, [addingField, inlineAdd, onDirtyChange])

  useEffect(() => {
    if (
      !inlineAdd
      || !isQualityForm
      || !existingForm
      || !fields.isSuccess
      || fields.data.length > 0
      || addingField
      || deletingEmptyFormIdRef.current === existingForm.id
    ) return
    deletingEmptyFormIdRef.current = existingForm.id
    deleteEmptyForm.mutate(existingForm.id)
  }, [addingField, deleteEmptyForm, existingForm, fields.data, fields.isSuccess, inlineAdd, isQualityForm])

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
      setQcAllocationMode(qualityConfig.data.allocationMode ?? 'claim')
    }
  }, [qualityConfig.data])
  const extractionConfig = useQuery({
    queryKey: ['extraction-config', projectId],
    queryFn: () => apiRequest<ExtractionConfig>(`/api/v1/projects/${projectId}/extraction-config`),
    enabled: Boolean(projectId) && !isQualityForm,
  })
  const extractionConfigSeeded = useRef(false)
  useEffect(() => {
    if (extractionConfig.data && !extractionConfigSeeded.current) {
      extractionConfigSeeded.current = true
      setExtractionAllocationMode(extractionConfig.data.allocationMode ?? 'claim')
    }
  }, [extractionConfig.data])

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
    onSuccess: (createdForm) => {
      setTemplateId('')
      queryClient.setQueryData<ReviewForm[]>(['forms', projectId], (current = []) => [
        ...current.filter((form) => form.id !== createdForm.id),
        createdForm,
      ])
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
    },
  })
  const addField = useMutation({
    mutationFn: async () => {
      let targetForm = existingForm
      if (!targetForm && inlineAdd) {
        const createdForm = await apiRequest<ReviewForm>(`/api/v1/projects/${projectId}/forms`, {
          method: 'POST',
          body: JSON.stringify({ name, kind, templateId: templateId || undefined }),
        })
        targetForm = createdForm
        queryClient.setQueryData<ReviewForm[]>(['forms', projectId], (current = []) => [
          ...current.filter((form) => form.id !== createdForm.id),
          createdForm,
        ])
      }
      if (!targetForm) throw new Error('Create a form before adding fields.')
      const field = await apiRequest<FormField>(`/api/v1/forms/${targetForm.id}/fields`, {
        method: 'POST',
        body: JSON.stringify({
          label: fieldLabel,
          fieldType,
          required,
          options: showOptions ? options : showRatingScale ? ratingOptions : [],
          scoring: buildScoring({ isQualityForm, fieldType, weight, options, optionScores, trueScore, falseScore }),
        }),
      })
      return { field, formId: targetForm.id }
    },
    onSuccess: ({ field, formId }) => {
      queryClient.setQueryData<FormField[]>(['form-fields', formId], (current = []) => [
        ...current.filter((item) => item.stableKey !== field.stableKey),
        field,
      ])
      resetNewField()
      setAddingField(false)
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
      queryClient.invalidateQueries({ queryKey: ['form-fields', formId] })
    },
  })
  const updateField = useMutation({
    mutationFn: (variables: {
      stableKey: string
      label: string
      fieldType: string
      required: boolean
      position: number
      options: string[]
      scoring: Record<string, unknown>
    }) => apiRequest<FormField>(
      `/api/v1/forms/${existingForm?.id}/fields/${variables.stableKey}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          label: variables.label,
          fieldType: variables.fieldType,
          required: variables.required,
          position: variables.position,
          options: variables.options,
          scoring: variables.scoring,
        }),
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
    mutationFn: (next: QualityConfig) => apiRequest(
      `/api/v1/projects/${projectId}/quality-config`,
      { method: 'PUT', body: JSON.stringify(next) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quality-config', projectId] }),
  })
  const updateQualityConfig = (next: QualityConfig) => {
    setQcEnabled(next.enabled)
    setQcMode(next.mode)
    setQcAggregation(next.aggregation)
    setQcAllocationMode(next.allocationMode)
    if (qualityConfigSeeded.current) saveQualityConfig.mutate(next)
  }
  const saveExtractionConfig = useMutation({
    mutationFn: (next: ExtractionConfig) => apiRequest(
      `/api/v1/projects/${projectId}/extraction-config`,
      { method: 'PUT', body: JSON.stringify(next) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['extraction-config', projectId] }),
  })
  const updateExtractionAllocationMode = (allocationMode: TaskAllocationMode) => {
    setExtractionAllocationMode(allocationMode)
    if (extractionConfigSeeded.current) saveExtractionConfig.mutate({ allocationMode })
  }

  const mutationError = createForm.error ?? addField.error ?? updateField.error
    ?? saveFieldOrder.error ?? removeField.error ?? deleteEmptyForm.error
  const activeFields = orderedFields.filter((field) => !field.isArchived)

  return (
    <section className="card">
      <h2>
        <span className="collapsible-section__title">
          <span className="collapsible-section__icon" aria-hidden="true">
            {isQualityForm ? <IconCheckCircle /> : <IconDownload />}
          </span>
          {title}
        </span>
      </h2>
      {description ? (
        <InfoBox icon={isQualityForm ? <IconCheckCircle /> : <IconDownload />}>
          <p>{description}</p>
        </InfoBox>
      ) : null}
      {forms.error ? <p className="error" role="alert">{forms.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}

      {isQualityForm ? (
        <div className="quality-settings-fields">
          <label>
            <input
              type="checkbox"
              checked={qcEnabled}
              onChange={(event) => updateQualityConfig({
                enabled: event.target.checked, mode: qcMode, aggregation: qcAggregation, allocationMode: qcAllocationMode,
              })}
            />
            Enable quality assessment
          </label>
          <div className="quality-settings-selects">
            <label>
              Mode
              <select
                value={qcMode}
                onChange={(event) => updateQualityConfig({
                  enabled: qcEnabled, mode: event.target.value, aggregation: qcAggregation, allocationMode: qcAllocationMode,
                })}
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
                onChange={(event) => updateQualityConfig({
                  enabled: qcEnabled, mode: qcMode, aggregation: event.target.value, allocationMode: qcAllocationMode,
                })}
              >
                <option value="sum">Simple sum</option>
                <option value="average">Average</option>
                <option value="weighted_average">Weighted average</option>
              </select>
            </label>
            <label>
              Allocation
              <select
                value={qcAllocationMode}
                onChange={(event) => updateQualityConfig({
                  enabled: qcEnabled, mode: qcMode, aggregation: qcAggregation,
                  allocationMode: event.target.value as TaskAllocationMode,
                })}
              >
                {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                  <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
                ))}
              </select>
            </label>
          </div>
          {saveQualityConfig.error ? <p className="error" role="alert">{saveQualityConfig.error.message}</p> : null}
          <p className="muted" aria-live="polite">
            {saveQualityConfig.isPending ? 'Saving…' : saveQualityConfig.isSuccess ? 'Saved.' : ' '}
          </p>
        </div>
      ) : (
        <div className="quality-settings-fields">
          <label>
            Allocation
            <select
              value={extractionAllocationMode}
              onChange={(event) => updateExtractionAllocationMode(event.target.value as TaskAllocationMode)}
            >
              {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
              ))}
            </select>
          </label>
          {saveExtractionConfig.error ? <p className="error" role="alert">{saveExtractionConfig.error.message}</p> : null}
          <p className="muted" aria-live="polite">
            {saveExtractionConfig.isPending ? 'Saving…' : saveExtractionConfig.isSuccess ? 'Saved.' : ' '}
          </p>
        </div>
      )}

      {!existingForm && !inlineAdd ? (
        <form onSubmit={(event) => {
          event.preventDefault()
          createForm.mutate()
        }}>
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
          <Button type="submit" variant="primary" loading={createForm.isPending}>
            <IconPlus />
            Create {isQualityForm ? 'Quality' : 'Extraction'} Form
          </Button>
        </form>
      ) : (
        <>
          {!inlineAdd ? (
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
                <Button type="submit" variant="primary" loading={addField.isPending}><IconPlus />Add Field</Button>
              </form>
            </>
          ) : null}

          <h3>Fields</h3>
          {fields.error ? <p className="error" role="alert">{fields.error.message}</p> : null}
          {activeFields.length === 0 && !inlineAdd ? <p className="muted">No fields added yet.</p> : (
            <div className="llm-schema-fields form-editor-fields">
              {activeFields.length === 0 && !addingField ? <p className="muted">No fields added yet.</p> : null}
              {activeFields.map((field) => {
                const fieldIndex = activeFields.findIndex((item) => item.stableKey === field.stableKey)
                return (
                  <details
                    className={`llm-schema-field form-editor-field${draggedFieldKey === field.stableKey ? ' llm-schema-field--dragging' : ''}${dragOverFieldKey === field.stableKey ? ' llm-schema-field--drag-over' : ''}`}
                    key={field.id}
                    data-ui="form-editor-field"
                    data-field-sort-key={field.stableKey}
                    data-drag-over={dragOverFieldKey === field.stableKey ? 'true' : undefined}
                    open={editingKey === field.stableKey}
                    onDragOver={(event) => {
                      if (!draggedFieldKey) return
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                      setDragOverFieldKey(field.stableKey)
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      const sourceKey = draggedFieldKey || event.dataTransfer.getData('text/plain')
                      if (sourceKey) moveFieldTo(sourceKey, field.stableKey)
                      setDraggedFieldKey(null)
                      setDragOverFieldKey(null)
                    }}
                  >
                    <summary
                      className="llm-schema-field__summary"
                      onClick={(event) => {
                        event.preventDefault()
                        if (editingKey === field.stableKey) {
                          setEditingKey(null)
                        } else {
                          beginEditingField(field)
                        }
                      }}
                    >
                      <span className="llm-schema-field__title">
                        <strong>{field.label}</strong>
                        <span className="status-badge">
                          {fieldTypeLabels[field.fieldType] ?? field.fieldType}
                          {field.fieldType === 'rating' ? ` (${describeRatingScale(field.options)})` : ''}
                        </span>
                        {field.required ? <span className="status-badge">Required</span> : null}
                      </span>
                      <span className="llm-schema-field__mapping">
                        {field.required ? 'Reviewers must complete this field' : 'Optional for reviewers'}
                      </span>
                      <span className="llm-schema-field__preview">
                        {field.fieldType === 'rating'
                          ? `Rating scale ${describeRatingScale(field.options)}`
                          : selectFieldTypes.has(field.fieldType)
                            ? field.options.length ? `Options: ${field.options.join(', ')}` : 'No options configured.'
                            : `${fieldTypeLabels[field.fieldType] ?? field.fieldType} response field`}
                      </span>
                      <DragHandle
                        label={field.label}
                        index={fieldIndex}
                        itemCount={activeFields.length}
                        disabled={activeFields.length < 2 || saveFieldOrder.isPending}
                        onMove={(targetIndex) => moveFieldTo(
                          field.stableKey,
                          activeFields[targetIndex].stableKey,
                        )}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', field.stableKey)
                          setDraggedFieldKey(field.stableKey)
                        }}
                        onDragEnd={() => {
                          setDraggedFieldKey(null)
                          setDragOverFieldKey(null)
                        }}
                        onPointerDragStart={() => setDraggedFieldKey(field.stableKey)}
                        onPointerDragOver={(targetKey) => setDragOverFieldKey(
                          targetKey === field.stableKey ? null : targetKey,
                        )}
                        onPointerDrop={(targetKey) => {
                          if (targetKey) moveFieldTo(field.stableKey, targetKey)
                          setDraggedFieldKey(null)
                          setDragOverFieldKey(null)
                        }}
                        onPointerDragCancel={() => {
                          setDraggedFieldKey(null)
                          setDragOverFieldKey(null)
                        }}
                      />
                    </summary>
                    <div className="llm-schema-field__content">
                      {editingKey === field.stableKey ? (
                        <FieldEditForm
                          field={field}
                          isQualityForm={isQualityForm}
                          editingLabel={editingLabel}
                          editingType={editingType}
                          editingRequired={editingRequired}
                          editingOptionsText={editingOptionsText}
                          editingRatingMin={editingRatingMin}
                          editingRatingMax={editingRatingMax}
                          editingWeight={editingWeight}
                          editingOptionScores={editingOptionScores}
                          editingTrueScore={editingTrueScore}
                          editingFalseScore={editingFalseScore}
                          onEditingLabelChange={setEditingLabel}
                          onEditingTypeChange={setEditingType}
                          onEditingRequiredChange={setEditingRequired}
                          onEditingOptionsTextChange={setEditingOptionsText}
                          onEditingRatingMinChange={setEditingRatingMin}
                          onEditingRatingMaxChange={setEditingRatingMax}
                          onEditingWeightChange={setEditingWeight}
                          onEditingOptionScoreChange={(option, value) => setEditingOptionScores((current) => ({
                            ...current,
                            [option]: value,
                          }))}
                          onEditingTrueScoreChange={setEditingTrueScore}
                          onEditingFalseScoreChange={setEditingFalseScore}
                          saving={updateField.isPending}
                          onSave={() => {
                            const editingOptions = parseOptions(editingOptionsText)
                            const nextOptions = selectFieldTypes.has(editingType)
                              ? editingOptions
                              : editingType === 'rating' ? [editingRatingMin, editingRatingMax] : []
                            updateField.mutate({
                              stableKey: field.stableKey,
                              label: editingLabel,
                              fieldType: editingType,
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
                          onCancel={cancelEditing}
                          trailingAction={(
                            <ConfirmButton
                              label="Remove"
                              confirmLabel="Remove Field"
                              warning={`Remove field "${field.label}"? This can't be undone.`}
                              onConfirm={() => removeField.mutate(field.stableKey)}
                              disabled={removeField.isPending}
                              variant="danger"
                              icon={<IconTrash />}
                            />
                          )}
                        />
                      ) : null}
                    </div>
                  </details>
                )
              })}
              {inlineAdd && addingField ? (
                <NewFieldDraftCard
                  fieldLabel={fieldLabel}
                  fieldType={fieldType}
                  required={required}
                  optionsText={optionsText}
                  ratingMin={ratingMin}
                  ratingMax={ratingMax}
                  weight={weight}
                  optionScores={optionScores}
                  trueScore={trueScore}
                  falseScore={falseScore}
                  isQualityForm={isQualityForm}
                  showOptions={showOptions}
                  showRatingScale={showRatingScale}
                  options={options}
                  onFieldLabelChange={setFieldLabel}
                  onFieldTypeChange={setFieldType}
                  onRequiredChange={setRequired}
                  onOptionsTextChange={setOptionsText}
                  onRatingMinChange={setRatingMin}
                  onRatingMaxChange={setRatingMax}
                  onWeightChange={setWeight}
                  onOptionScoreChange={(option, value) => setOptionScores((current) => ({
                    ...current,
                    [option]: value,
                  }))}
                  onTrueScoreChange={setTrueScore}
                  onFalseScoreChange={setFalseScore}
                  onSubmit={() => addField.mutate()}
                  onCancel={() => { addField.reset(); resetNewField(); setAddingField(false) }}
                  saving={addField.isPending}
                />
              ) : null}
              {inlineAdd ? (
                <button
                  type="button"
                  className="icon-button icon-button--round form-editor-fields__add-button"
                  aria-label="Add form field"
                  title="Add form field"
                  disabled={addingField || addField.isPending || createForm.isPending}
                  onClick={() => {
                    addField.reset()
                    createForm.reset()
                    resetNewField()
                    setAddingField(true)
                  }}
                >
                  <IconPlus />
                </button>
              ) : null}
            </div>
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
