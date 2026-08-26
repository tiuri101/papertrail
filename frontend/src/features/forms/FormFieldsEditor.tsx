import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { apiRequest } from '../../api/client'
import { Badge } from '../../components/Badge'
import { cardStyles } from '../../components/Card'
import { ConfirmButton } from '../../components/ConfirmButton'
import { DragHandle } from '../../components/DragHandle'
import { IconPlus } from '../../components/icons'
import { cn } from '../../lib/cn'
import { DynamicForm } from './DynamicForm'
import { FieldEditForm } from './FieldEditForm'
import {
  buildScoring,
  describeRatingScale,
  fieldTypeLabels,
  parseOptions,
  selectFieldTypes,
} from './fieldTypes'
import { NewFieldDraftCard } from './NewFieldDraftCard'
import type { FormField } from './types'
import { useFormFieldEditor } from './useFormFieldEditor'
import { IconButton } from '../../components/Button'
import {
  llmSchemaContentClass,
  llmSchemaFieldClass,
  llmSchemaFieldsClass,
  llmSchemaMappingClass,
  llmSchemaPreviewClass,
  llmSchemaSummaryClass,
  llmSchemaTitleClass,
} from '../llm/llmStyles'

/**
 * Fields list + inline add/edit/reorder/preview for one already-existing form (a project's
 * extraction/quality form, or a template). Shared between FormKindSection and the Manage
 * Templates inspector so the two contexts stay visually and behaviorally identical; `readOnly`
 * and `emptyState` are the only real differences between them.
 *
 * Field removal always archives (never hard-deletes): even a template's fields are kept as
 * history rather than destroyed, matching how this page has always treated removal (distinct
 * from the project-setup wizard's FormFieldsPanel, which hard-deletes since no submissions can
 * exist yet at that point in a project's life).
 */
export function FormFieldsEditor({
  formId,
  isQualityForm,
  readOnly,
  emptyState,
}: {
  formId: string
  isQualityForm: boolean
  readOnly: boolean
  /** Shown in place of the fields list when there are no active fields yet. */
  emptyState?: ReactNode
}) {
  const queryClient = useQueryClient()
  const fields = useQuery({
    queryKey: ['form-fields', formId],
    queryFn: () => apiRequest<FormField[]>(`/api/v1/forms/${formId}/fields`),
  })

  const saveFieldOrder = useMutation({
    mutationFn: ({ stableKey, position }: { stableKey: string; position: number }) => apiRequest<FormField>(
      `/api/v1/forms/${formId}/fields/${stableKey}`,
      { method: 'PATCH', body: JSON.stringify({ position }) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['form-fields', formId] }),
    onError: () => queryClient.invalidateQueries({ queryKey: ['form-fields', formId] }),
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

  const showOptions = selectFieldTypes.has(fieldType)
  const showRatingScale = fieldType === 'rating'
  const options = parseOptions(optionsText)
  const ratingOptions = [ratingMin, ratingMax]

  const addField = useMutation({
    mutationFn: () => apiRequest<FormField>(
      `/api/v1/forms/${formId}/fields`,
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
      resetNewField()
      setAddingField(false)
      queryClient.invalidateQueries({ queryKey: ['form-fields', formId] })
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
          ? `/api/v1/forms/${formId}/fields/${variables.stableKey}/replace`
          : `/api/v1/forms/${formId}/fields/${variables.stableKey}`,
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
      queryClient.invalidateQueries({ queryKey: ['form-fields', formId] })
    },
  })
  const archiveField = useMutation({
    mutationFn: (stableKey: string) => apiRequest<FormField>(
      `/api/v1/forms/${formId}/fields/${stableKey}`,
      { method: 'PATCH', body: JSON.stringify({ archive: true }) },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['form-fields', formId] }),
  })

  const mutationError = fields.error ?? addField.error ?? updateField.error ?? saveFieldOrder.error ?? archiveField.error
  const activeFields = orderedFields.filter((field) => !field.isArchived)

  return (
    <div>
      {mutationError ? <p className="text-danger" role="alert">{mutationError.message}</p> : null}
      {activeFields.length === 0 && !addingField && readOnly ? (
        <p className="text-text">No fields added yet.</p>
      ) : (
        <div className={cn(llmSchemaFieldsClass, 'form-editor-fields')}>
          {activeFields.length === 0 && !addingField ? emptyState ?? <p className="text-text">No fields added yet.</p> : null}
          {orderedFields.map((field) => {
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
                data-field-sort-key={field.isArchived ? undefined : field.stableKey}
                data-drag-over={dragOverFieldKey === field.stableKey ? 'true' : undefined}
                open={field.isArchived ? undefined : editingKey === field.stableKey}
                onDragOver={(event) => {
                  if (!draggedFieldKey || field.isArchived || readOnly) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDragOverFieldKey(field.stableKey)
                }}
                onDrop={(event) => {
                  if (field.isArchived || readOnly) return
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
                    if (field.isArchived) return
                    if (readOnly) return
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
                    {field.isArchived ? <Badge variant="plain">Archived</Badge> : null}
                  </span>
                  <span className={llmSchemaMappingClass}>
                    {field.isArchived
                      ? 'Archived field retained for historical submissions'
                      : field.required ? 'Reviewers must complete this field' : 'Optional for reviewers'}
                  </span>
                  <span className={llmSchemaPreviewClass}>
                    {field.fieldType === 'rating'
                      ? `Rating scale ${describeRatingScale(field.options)}`
                      : selectFieldTypes.has(field.fieldType)
                        ? field.options.length ? `Options: ${field.options.join(', ')}` : 'No options configured.'
                        : `${fieldTypeLabels[field.fieldType] ?? field.fieldType} response field`}
                  </span>
                  {!field.isArchived && !readOnly ? (
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
                  ) : null}
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
                      onCancel={cancelEditing}
                      trailingAction={!field.isArchived ? (
                        <ConfirmButton
                          label="Archive"
                          confirmLabel="Archive Field"
                          warning={`Archive field "${field.label}"? It will be removed from new submissions, but every value already recorded for it is kept and can still be included in exports.`}
                          onConfirm={() => archiveField.mutate(field.stableKey)}
                          disabled={archiveField.isPending}
                          variant="danger"
                        />
                      ) : null}
                    />
                  ) : field.isArchived ? (
                    <p className="text-text">
                      This field is no longer shown on new submissions. Previously recorded values are preserved.
                    </p>
                  ) : null}
                </div>
              </details>
            )
          })}
          {!readOnly && addingField ? (
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
          {!readOnly ? (
            <IconButton
              type="button"
              size="sm"
              variant="secondary"
              className="!size-[30px] !min-h-[30px] !min-w-[30px] justify-self-start rounded-full"
              aria-label="Add form field"
              title="Add form field"
              disabled={addingField || addField.isPending}
              onClick={() => { addField.reset(); resetNewField(); setAddingField(true) }}
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
    </div>
  )
}
