import { toolbarClass } from '../../components/layoutStyles'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { ConfirmButton } from '../../components/ConfirmButton'
import { Button, IconButton } from '../../components/Button'
import { cardStyles } from '../../components/Card'
import { DragHandle } from '../../components/DragHandle'
import { IconCheckCircle, IconDownload, IconPlus, IconTrash } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { Textarea } from '../../components/Textarea'
import { DynamicForm } from './DynamicForm'
import { cn } from '../../lib/cn'
import { llmSchemaContentClass, llmSchemaFieldClass, llmSchemaFieldsClass, llmSchemaMappingClass, llmSchemaPreviewClass, llmSchemaSummaryClass, llmSchemaTitleClass } from '../llm/llmStyles'
import {
  buildScoring,
  describeRatingScale,
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
  position: number
  isArchived: boolean
  options: string[]
  scoring: Record<string, unknown>
}

type TaskAllocationMode = 'pre_assigned' | 'claim'

const TASK_ALLOCATION_MODE_LABELS: Record<TaskAllocationMode, string> = {
  claim: 'Claim (reviewers pick up publications themselves)',
  pre_assigned: 'Pre-assigned (publications are split across reviewers)',
}

interface QualityConfig {
  enabled: boolean
  mode: string
  aggregation: string
  allocationMode: TaskAllocationMode
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
  const [addingField, setAddingField] = useState(false)
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
  const [draggedFieldKey, setDraggedFieldKey] = useState<string | null>(null)
  const [dragOverFieldKey, setDragOverFieldKey] = useState<string | null>(null)
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, unknown>>({})
  const deletingEmptyFormIdRef = useRef<string | null>(null)

  useEffect(() => {
    onDirtyChange?.(inlineAdd && addingField)
  }, [addingField, inlineAdd, onDirtyChange])

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
  useEffect(() => {
    setFieldOrder(fields.data?.map((field) => field.stableKey) ?? [])
  }, [fields.data])
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
      setFieldLabel('')
      setRequired(false)
      setOptionsText('')
      setRatingMin('1')
      setRatingMax('5')
      setWeight('')
      setOptionScores({})
      setTrueScore('')
      setFalseScore('')
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
  const saveFieldOrder = useMutation({
    mutationFn: ({ stableKey, position }: { stableKey: string; position: number }) => apiRequest<FormField>(
      `/api/v1/forms/${existingForm?.id}/fields/${stableKey}`,
      { method: 'PATCH', body: JSON.stringify({ position }) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['form-fields', existingForm?.id] }),
    onError: () => queryClient.invalidateQueries({ queryKey: ['form-fields', existingForm?.id] }),
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

  const moveFieldTo = (stableKey: string, targetStableKey: string) => {
    const sourceIndex = fieldOrder.indexOf(stableKey)
    const targetIndex = fieldOrder.indexOf(targetStableKey)
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return
    const next = [...fieldOrder]
    next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, stableKey)
    setFieldOrder(next)
    saveFieldOrder.mutate({ stableKey, position: targetIndex })
  }

  const orderedFields = [...(fields.data ?? [])].sort((left, right) => {
    const leftIndex = fieldOrder.indexOf(left.stableKey)
    const rightIndex = fieldOrder.indexOf(right.stableKey)
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
  })

  const mutationError = createForm.error ?? addField.error ?? updateField.error
    ?? saveFieldOrder.error ?? removeField.error ?? deleteEmptyForm.error
  const activeFields = orderedFields.filter((field) => !field.isArchived)

  const resetNewField = () => {
    setFieldLabel('')
    setFieldType('long_text')
    setRequired(false)
    setOptionsText('')
    setRatingMin('1')
    setRatingMax('5')
    setWeight('')
    setOptionScores({})
    setTrueScore('')
    setFalseScore('')
  }

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
        <div className="grid gap-5">
          <label>
            <Input
              type="checkbox"
              checked={qcEnabled}
              onChange={(event) => updateQualityConfig({
                enabled: event.target.checked, mode: qcMode, aggregation: qcAggregation, allocationMode: qcAllocationMode,
              })}
            />
            Enable quality assessment
          </label>
          <div className="grid grid-cols-1 gap-4 min-[561px]:grid-cols-2">
            <label>
              Mode
              <Select
                value={qcMode}
                onChange={(event) => updateQualityConfig({
                  enabled: qcEnabled, mode: event.target.value, aggregation: qcAggregation, allocationMode: qcAllocationMode,
                })}
              >
                <option value="qualitative">Qualitative only</option>
                <option value="numeric">Numerical scoring only</option>
                <option value="both">Both</option>
              </Select>
            </label>
            <label>
              Aggregation
              <Select
                value={qcAggregation}
                onChange={(event) => updateQualityConfig({
                  enabled: qcEnabled, mode: qcMode, aggregation: event.target.value, allocationMode: qcAllocationMode,
                })}
              >
                <option value="sum">Simple sum</option>
                <option value="average">Average</option>
                <option value="weighted_average">Weighted average</option>
              </Select>
            </label>
            <label>
              Allocation
              <Select
                value={qcAllocationMode}
                onChange={(event) => updateQualityConfig({
                  enabled: qcEnabled, mode: qcMode, aggregation: qcAggregation,
                  allocationMode: event.target.value as TaskAllocationMode,
                })}
              >
                {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                  <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
                ))}
              </Select>
            </label>
          </div>
          {saveQualityConfig.error ? <p className="text-danger" role="alert">{saveQualityConfig.error.message}</p> : null}
          <p className="text-text-muted" aria-live="polite">
            {saveQualityConfig.isPending ? 'Saving…' : saveQualityConfig.isSuccess ? 'Saved.' : ' '}
          </p>
        </div>
      ) : (
        <div className="grid gap-5">
          <label>
            Allocation
            <Select
              value={extractionAllocationMode}
              onChange={(event) => updateExtractionAllocationMode(event.target.value as TaskAllocationMode)}
            >
              {(Object.keys(TASK_ALLOCATION_MODE_LABELS) as TaskAllocationMode[]).map((value) => (
                <option key={value} value={value}>{TASK_ALLOCATION_MODE_LABELS[value]}</option>
              ))}
            </Select>
          </label>
          {saveExtractionConfig.error ? <p className="text-danger" role="alert">{saveExtractionConfig.error.message}</p> : null}
          <p className="text-text-muted" aria-live="polite">
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
            <Input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Start from template (optional)
            <Select value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">From scratch</option>
              {templatesForKind.map((template) => (
                <option key={template.id} value={template.id}>{template.name}</option>
              ))}
            </Select>
          </label>
          {templates.error ? <p className="text-danger" role="alert">{templates.error.message}</p> : null}
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
              <Input value={fieldLabel} onChange={(event) => setFieldLabel(event.target.value)} required />
            </label>
            <label>
              Type
              <Select value={fieldType} onChange={(event) => setFieldType(event.target.value)}>
                {fieldTypes.map((type) => (
                  <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
                ))}
              </Select>
            </label>
            <label>
              <Input
                type="checkbox"
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
              />
              Required
            </label>
            {showOptions ? (
              <label>
                Options (one per line)
                <Textarea
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
                  <Input type="number" value={ratingMin} onChange={(event) => setRatingMin(event.target.value)} />
                </label>
                <label>
                  Scale maximum
                  <Input type="number" value={ratingMax} onChange={(event) => setRatingMax(event.target.value)} />
                </label>
              </>
            ) : null}
            {isQualityForm && weightedFieldTypes.has(fieldType) ? (
              <label>
                Score weight
                <Input type="number" value={weight} onChange={(event) => setWeight(event.target.value)} />
              </label>
            ) : null}
            {isQualityForm && fieldType === 'single_select' ? (
              <fieldset>
                <legend>Score per option</legend>
                {options.length === 0 ? <p className="text-text-muted">Add options above first.</p> : null}
                {options.map((option) => (
                  <label key={option}>
                    {option}
                    <Input
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
                  <Input type="number" value={trueScore} onChange={(event) => setTrueScore(event.target.value)} />
                </label>
                <label>
                  Score if unchecked
                  <Input type="number" value={falseScore} onChange={(event) => setFalseScore(event.target.value)} />
                </label>
              </>
            ) : null}
                <Button type="submit" variant="primary" loading={addField.isPending}><IconPlus />Add Field</Button>
              </form>
            </>
          ) : null}

          <h3>Fields</h3>
          {fields.error ? <p className="text-danger" role="alert">{fields.error.message}</p> : null}
          {activeFields.length === 0 && !inlineAdd ? <p className="text-text-muted">No fields added yet.</p> : (
            <div className={llmSchemaFieldsClass}>
              {activeFields.length === 0 && !addingField ? <p className="text-text-muted">No fields added yet.</p> : null}
              {activeFields.map((field) => {
                const editingOptions = parseOptions(editingOptionsText)
                const fieldIndex = activeFields.findIndex((item) => item.stableKey === field.stableKey)
                return (
                  <details
                    className={llmSchemaFieldClass({ dragging: draggedFieldKey === field.stableKey, dragOver: dragOverFieldKey === field.stableKey })}
                    data-ui="form-editor-field"
                    data-dragging={draggedFieldKey === field.stableKey || undefined}
                    data-drag-over={dragOverFieldKey === field.stableKey || undefined}
                    key={field.id}
                    data-field-sort-key={field.stableKey}
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
                        <>
                          <label>
                            Label
                            <Input
                              aria-label={`Edit label for ${field.label}`}
                              value={editingLabel}
                              onChange={(event) => setEditingLabel(event.target.value)}
                            />
                          </label>
                          <label>
                            Type
                            <Select
                              aria-label={`Edit type for ${field.label}`}
                              value={editingType}
                              onChange={(event) => setEditingType(event.target.value)}
                            >
                              {fieldTypes.map((type) => (
                                <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
                              ))}
                            </Select>
                          </label>
                          <label>
                            <Input
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
                              <Textarea
                                aria-label={`Edit options for ${field.label}`}
                                value={editingOptionsText}
                                onChange={(event) => setEditingOptionsText(event.target.value)}
                                rows={4}
                              />
                            </label>
                          ) : null}
                          {editingType === 'rating' ? (
                            <div className="grid grid-cols-1 gap-4 min-[681px]:grid-cols-2">
                              <label>
                                Scale minimum
                                <Input
                                  type="number"
                                  aria-label={`Edit scale minimum for ${field.label}`}
                                  value={editingRatingMin}
                                  onChange={(event) => setEditingRatingMin(event.target.value)}
                                />
                              </label>
                              <label>
                                Scale maximum
                                <Input
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
                              <Input
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
                              {editingOptions.length === 0 ? <p className="text-text-muted">Add options above first.</p> : null}
                              {editingOptions.map((option) => (
                                <label key={option}>
                                  {option}
                                  <Input
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
                            <div className="grid grid-cols-1 gap-4 min-[681px]:grid-cols-2">
                              <label>
                                Score if checked
                                <Input
                                  type="number"
                                  aria-label={`Edit checked score for ${field.label}`}
                                  value={editingTrueScore}
                                  onChange={(event) => setEditingTrueScore(event.target.value)}
                                />
                              </label>
                              <label>
                                Score if unchecked
                                <Input
                                  type="number"
                                  aria-label={`Edit unchecked score for ${field.label}`}
                                  value={editingFalseScore}
                                  onChange={(event) => setEditingFalseScore(event.target.value)}
                                />
                              </label>
                            </div>
                          ) : null}
                          <div className={toolbarClass}>
                            <Button
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
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => {
                                setEditingKey(null)
                                setFieldOrder(fields.data?.map((item) => item.stableKey) ?? [])
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                          <ConfirmButton
                            label="Remove"
                            confirmLabel="Remove Field"
                            warning={`Remove field "${field.label}"? This can't be undone.`}
                            onConfirm={() => removeField.mutate(field.stableKey)}
                            disabled={removeField.isPending}
                            variant="danger"
                            icon={<IconTrash />}
                          />
                        </>
                      ) : null}
                    </div>
                  </details>
                )
              })}
              {inlineAdd && addingField ? (
                <div className={llmSchemaFieldClass({ draft: true })} data-ui="form-editor-field" data-draft="true">
                  <div className={cn(llmSchemaSummaryClass, 'cursor-default')}>
                    <span className={llmSchemaTitleClass}>
                      <strong>{fieldLabel.trim() || 'New field'}</strong>
                      <Badge variant="plain">{fieldTypeLabels[fieldType] ?? fieldType}</Badge>
                      {required ? <Badge variant="plain">Required</Badge> : null}
                    </span>
                    <span className={llmSchemaMappingClass}>
                      {required ? 'Reviewers must complete this field' : 'Optional for reviewers'}
                    </span>
                    <span className={llmSchemaPreviewClass}>Configure the new response field below.</span>
                  </div>
                  <form
                    className={cn(llmSchemaContentClass, 'grid-cols-1')}
                    onSubmit={(event) => { event.preventDefault(); addField.mutate() }}
                  >
                    <label>
                      Label
                      <Input
                        value={fieldLabel}
                        onChange={(event) => setFieldLabel(event.target.value)}
                        autoFocus
                        required
                      />
                    </label>
                    <label>
                      Type
                      <Select value={fieldType} onChange={(event) => setFieldType(event.target.value)}>
                        {fieldTypes.map((type) => (
                          <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
                        ))}
                      </Select>
                    </label>
                    <label>
                      <Input
                        type="checkbox"
                        checked={required}
                        onChange={(event) => setRequired(event.target.checked)}
                      />
                      Required
                    </label>
                    {showOptions ? (
                      <label>
                        Options (one per line)
                        <Textarea
                          value={optionsText}
                          onChange={(event) => setOptionsText(event.target.value)}
                          rows={4}
                        />
                      </label>
                    ) : null}
                    {showRatingScale ? (
                      <div className="grid grid-cols-1 gap-4 min-[681px]:grid-cols-2">
                        <label>
                          Scale minimum
                          <Input type="number" value={ratingMin} onChange={(event) => setRatingMin(event.target.value)} />
                        </label>
                        <label>
                          Scale maximum
                          <Input type="number" value={ratingMax} onChange={(event) => setRatingMax(event.target.value)} />
                        </label>
                      </div>
                    ) : null}
                    {isQualityForm && weightedFieldTypes.has(fieldType) ? (
                      <label>
                        Score weight
                        <Input type="number" value={weight} onChange={(event) => setWeight(event.target.value)} />
                      </label>
                    ) : null}
                    {isQualityForm && fieldType === 'single_select' ? (
                      <fieldset>
                        <legend>Score per option</legend>
                        {options.length === 0 ? <p className="text-text-muted">Add options above first.</p> : null}
                        {options.map((option) => (
                          <label key={option}>
                            {option}
                            <Input
                              type="number"
                              value={optionScores[option] ?? ''}
                              onChange={(event) => setOptionScores((current) => ({
                                ...current,
                                [option]: event.target.value,
                              }))}
                            />
                          </label>
                        ))}
                      </fieldset>
                    ) : null}
                    {isQualityForm && fieldType === 'checkbox' ? (
                      <div className="grid grid-cols-1 gap-4 min-[681px]:grid-cols-2">
                        <label>
                          Score if checked
                          <Input type="number" value={trueScore} onChange={(event) => setTrueScore(event.target.value)} />
                        </label>
                        <label>
                          Score if unchecked
                          <Input type="number" value={falseScore} onChange={(event) => setFalseScore(event.target.value)} />
                        </label>
                      </div>
                    ) : null}
                    <div className={toolbarClass}>
                      <Button
                        type="submit"
                        variant="primary"
                        loading={addField.isPending}
                        disabled={!fieldLabel.trim()}
                      >
                        <IconCheckCircle />Save Field
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={addField.isPending}
                        onClick={() => { addField.reset(); resetNewField(); setAddingField(false) }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                </div>
              ) : null}
              {inlineAdd ? (
                <IconButton
                  variant="secondary"
                  size="sm"
                  className="size-[30px]! min-w-[30px]! min-h-[30px]! justify-self-start rounded-full! [&_svg]:size-4!"
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
