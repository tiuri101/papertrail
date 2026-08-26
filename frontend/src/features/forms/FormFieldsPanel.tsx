import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { cardStyles } from '../../components/Card'
import { ConfirmButton } from '../../components/ConfirmButton'
import { Button, IconButton } from '../../components/Button'
import { DragHandle } from '../../components/DragHandle'
import { IconCheckCircle, IconDownload, IconPlus, IconTrash } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import {
  QUALITY_AGGREGATIONS,
  QUALITY_AGGREGATION_LABELS,
  QUALITY_MODES,
  QUALITY_MODE_LABELS,
  type QualityAggregation,
  type QualityConfig,
  type QualityMode,
} from '../quality/types'
import { LockableField, SettingsSaveBar } from '../administration/SettingsSaveBar'
import { useStructuralSettingsForm } from '../administration/useStructuralSettingsForm'
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
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { Textarea } from '../../components/Textarea'
import { FieldLabel } from '../../components/FieldLabel'
import { Form } from '../../components/Form'
import { Fieldset } from '../../components/Fieldset'
import { FieldLegend } from '../../components/FieldLegend'
import { cn } from '../../lib/cn'
import {
  llmSchemaContentClass,
  llmSchemaFieldClass,
  llmSchemaFieldsClass,
  llmSchemaMappingClass,
  llmSchemaPreviewClass,
  llmSchemaSummaryClass,
  llmSchemaTitleClass,
} from '../llm/llmStyles'

type FormKind = 'extraction' | 'quality'

type TaskAllocationMode = QualityConfig['allocationMode']

const TASK_ALLOCATION_MODE_LABELS: Record<TaskAllocationMode, string> = {
  claim: 'Claim (reviewers pick up publications themselves)',
  pre_assigned: 'Pre-assigned (publications are split across reviewers)',
}

interface ExtractionConfig {
  allocationMode: TaskAllocationMode
  // Part of the configuration whether or not this panel edits it: the PUT
  // replaces the whole record, so omitting it (as this panel used to) is
  // rejected outright by the API.
  requiredReviewers: number
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

  // Same shared form state the dedicated settings panels use: reseeded per
  // project, saved explicitly one request at a time, and able to freeze a
  // control the backend has locked. Only the panel's own kind is fetched.
  const qualityForm = useStructuralSettingsForm<QualityConfig, QualityConfig>({
    projectId: isQualityForm ? projectId : '',
    queryKey: 'quality-config',
    resource: 'quality-config',
    toDraft: (config) => ({
      enabled: config.enabled ?? false,
      mode: config.mode ?? 'both',
      aggregation: config.aggregation ?? 'sum',
      allocationMode: config.allocationMode ?? 'claim',
    }),
  })
  const extractionForm = useStructuralSettingsForm<ExtractionConfig, ExtractionConfig>({
    projectId: isQualityForm ? '' : projectId,
    queryKey: 'extraction-config',
    resource: 'extraction-config',
    toDraft: (config) => ({
      allocationMode: config.allocationMode ?? 'claim',
      requiredReviewers: config.requiredReviewers ?? 1,
    }),
  })

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
  const mutationError = createForm.error ?? addField.error ?? updateField.error
    ?? saveFieldOrder.error ?? removeField.error ?? deleteEmptyForm.error
  const activeFields = orderedFields.filter((field) => !field.isArchived)

  return (
    <section className={cardStyles} data-ui="card">
      <h2>
        <span className="collapsible-section__title inline-flex items-center gap-2">
          <span className="collapsible-section__icon inline-flex shrink-0 text-primary [&_svg]:size-5 [&_svg]:fill-current" aria-hidden="true">
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
      {forms.error ? <p className="text-danger" role="alert">{forms.error.message}</p> : null}
      {mutationError ? <p className="text-danger" role="alert">{mutationError.message}</p> : null}

      {isQualityForm ? (
        qualityForm.draft ? (
          <div className="quality-settings-fields grid gap-5">
            <FieldLabel inline>
              <Input
                type="checkbox"
                checked={qualityForm.draft.enabled}
                onChange={(event) => qualityForm.change({ enabled: event.target.checked })}
              />
              Enable quality assessment
            </FieldLabel>
            <div className="quality-settings-selects grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
              <LockableField locked={qualityForm.locks.mode}>
                <FieldLabel>
                  Mode
                  <Select
                    value={qualityForm.draft.mode}
                    disabled={Boolean(qualityForm.locks.mode)}
                    onChange={(event) => qualityForm.change({ mode: event.target.value as QualityMode })}
                  >
                    {QUALITY_MODES.map((value) => (
                      <option key={value} value={value}>{QUALITY_MODE_LABELS[value]}</option>
                    ))}
                  </Select>
                </FieldLabel>
              </LockableField>
              <LockableField locked={qualityForm.locks.aggregation}>
                <FieldLabel>
                  Aggregation
                  <Select
                    value={qualityForm.draft.aggregation}
                    disabled={Boolean(qualityForm.locks.aggregation)}
                    onChange={(event) => qualityForm.change({ aggregation: event.target.value as QualityAggregation })}
                  >
                    {QUALITY_AGGREGATIONS.map((value) => (
                      <option key={value} value={value}>{QUALITY_AGGREGATION_LABELS[value]}</option>
                    ))}
                  </Select>
                </FieldLabel>
              </LockableField>
              <LockableField locked={qualityForm.locks.allocationMode}>
                <FieldLabel>
                  Allocation
                  <Select
                    value={qualityForm.draft.allocationMode}
                    disabled={Boolean(qualityForm.locks.allocationMode)}
                    onChange={(event) => qualityForm.change({
                      allocationMode: event.target.value as TaskAllocationMode,
                    })}
                  >
                    {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                      <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
                    ))}
                  </Select>
                </FieldLabel>
              </LockableField>
            </div>
            {qualityForm.saveError ? <p className="text-danger" role="alert">{qualityForm.saveError.message}</p> : null}
            <SettingsSaveBar
              status={qualityForm.status}
              dirty={qualityForm.dirty}
              onSave={qualityForm.submit}
              onRevert={qualityForm.revert}
            />
          </div>
        ) : null
      ) : (
        extractionForm.draft ? (
          <div className="quality-settings-fields grid gap-5">
            <LockableField locked={extractionForm.locks.allocationMode}>
              <FieldLabel>
                Allocation
                <Select
                  value={extractionForm.draft.allocationMode}
                  disabled={Boolean(extractionForm.locks.allocationMode)}
                  onChange={(event) => extractionForm.change({
                    allocationMode: event.target.value as TaskAllocationMode,
                  })}
                >
                  {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                    <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
                  ))}
                </Select>
              </FieldLabel>
            </LockableField>
            {extractionForm.saveError ? <p className="text-danger" role="alert">{extractionForm.saveError.message}</p> : null}
            <SettingsSaveBar
              status={extractionForm.status}
              dirty={extractionForm.dirty}
              onSave={extractionForm.submit}
              onRevert={extractionForm.revert}
            />
          </div>
        ) : null
      )}

      {!existingForm && !inlineAdd ? (
        <Form onSubmit={(event) => {
          event.preventDefault()
          createForm.mutate()
        }}>
          <FieldLabel>
            Name
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </FieldLabel>
          <FieldLabel>
            Start from template (optional)
            <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">From scratch</option>
              {templatesForKind.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </Select>
          </FieldLabel>
          {templates.error ? <p className="text-danger" role="alert">{templates.error.message}</p> : null}
          <Button type="submit" variant="primary" loading={createForm.isPending}>
            <IconPlus />
            Create {isQualityForm ? 'Quality' : 'Extraction'} Form
          </Button>
        </Form>
      ) : (
        <>
          {!inlineAdd ? (
            <>
              <h3>Add Field</h3>
              <Form onSubmit={(event) => { event.preventDefault(); addField.mutate() }}>
            <FieldLabel>
              Label
              <Input value={fieldLabel} onChange={(event) => setFieldLabel(event.target.value)} required />
            </FieldLabel>
            <FieldLabel>
              Type
              <Select value={fieldType} onChange={(event) => setFieldType(event.target.value)}>
                {fieldTypes.map((type) => (
                  <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
                ))}
              </Select>
            </FieldLabel>
            <FieldLabel inline>
              <Input
                type="checkbox"
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
              />
              Required
            </FieldLabel>
            {showOptions ? (
              <FieldLabel>
                Options (one per line)
                <Textarea
                  value={optionsText}
                  onChange={(event) => setOptionsText(event.target.value)}
                  rows={4}
                />
              </FieldLabel>
            ) : null}
            {showRatingScale ? (
              <>
                <FieldLabel>
                  Scale minimum
                  <Input type="number" value={ratingMin} onChange={(event) => setRatingMin(event.target.value)} />
                </FieldLabel>
                <FieldLabel>
                  Scale maximum
                  <Input type="number" value={ratingMax} onChange={(event) => setRatingMax(event.target.value)} />
                </FieldLabel>
              </>
            ) : null}
            {isQualityForm && weightedFieldTypes.has(fieldType) ? (
              <FieldLabel>
                Score weight
                <Input type="number" value={weight} onChange={(event) => setWeight(event.target.value)} />
              </FieldLabel>
            ) : null}
            {isQualityForm && fieldType === 'single_select' ? (
              <Fieldset>
                <FieldLegend>Score per option</FieldLegend>
                {options.length === 0 ? <p className="text-text">Add options above first.</p> : null}
                {options.map((option) => (
                  <FieldLabel key={option}>
                    {option}
                    <Input
                      type="number"
                      value={optionScores[option] ?? ''}
                      onChange={(event) => setOptionScores((current) => ({ ...current, [option]: event.target.value }))}
                    />
                  </FieldLabel>
                ))}
              </Fieldset>
            ) : null}
            {isQualityForm && fieldType === 'checkbox' ? (
              <>
                <FieldLabel>
                  Score if checked
                  <Input type="number" value={trueScore} onChange={(event) => setTrueScore(event.target.value)} />
                </FieldLabel>
                <FieldLabel>
                  Score if unchecked
                  <Input type="number" value={falseScore} onChange={(event) => setFalseScore(event.target.value)} />
                </FieldLabel>
              </>
            ) : null}
                <Button type="submit" variant="primary" loading={addField.isPending}><IconPlus />Add Field</Button>
              </Form>
            </>
          ) : null}

          <h3>Fields</h3>
          {fields.error ? <p className="text-danger" role="alert">{fields.error.message}</p> : null}
          {activeFields.length === 0 && !inlineAdd ? <p className="text-text">No fields added yet.</p> : (
            <div className={cn(llmSchemaFieldsClass, 'form-editor-fields')}>
              {activeFields.length === 0 && !addingField ? <p className="text-text">No fields added yet.</p> : null}
              {activeFields.map((field) => {
                const fieldIndex = activeFields.findIndex((item) => item.stableKey === field.stableKey)
                return (
                  <details
                    className={cn(
                      llmSchemaFieldClass({
                        dragging: draggedFieldKey === field.stableKey,
                        dragOver: dragOverFieldKey === field.stableKey,
                      }),
                      'form-editor-field',
                    )}
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
                      className={llmSchemaSummaryClass}
                      onClick={(event) => {
                        event.preventDefault()
                        if (editingKey === field.stableKey) {
                          setEditingKey(null)
                        } else {
                          beginEditingField(field)
                        }
                      }}
                    >
                      <span className={llmSchemaTitleClass}>
                        <strong>{field.label}</strong>
                        <Badge variant="plain">
                          {fieldTypeLabels[field.fieldType] ?? field.fieldType}
                          {field.fieldType === 'rating' ? ` (${describeRatingScale(field.options)})` : ''}
                        </Badge>
                        {field.required ? <Badge variant="plain">Required</Badge> : null}
                      </span>
                      <span className={llmSchemaMappingClass}>
                        {field.required ? 'Reviewers must complete this field' : 'Optional for reviewers'}
                      </span>
                      <span className={llmSchemaPreviewClass}>
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
                    <div className={llmSchemaContentClass}>
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
                              className="w=fit justify-self-start"
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
                <IconButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="!size-[30px] !min-h-[30px] !min-w-[30px] justify-self-start rounded-full"
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
                </IconButton>
              ) : null}
            </div>
          )}

          {activeFields.length ? (
            <>
              <h3>Preview</h3>
              <div className={cardStyles} data-ui="card">
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
