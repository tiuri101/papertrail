import { useEffect, useState } from 'react'

import type { FormField } from './types'

/**
 * Shared field-editor state machine used by both the standalone form builder
 * (`FormBuilderPage`) and the embedded project-setup wizard step
 * (`FormFieldsPanel`). Owns the "new field" draft state, the "editing an
 * existing field" state, drag-and-drop reorder state, and the field-preview
 * answers — plus the pure derived values and helpers built on top of them
 * (ordered field list, begin-editing seeding, drag-and-drop reordering,
 * resetting the draft).
 *
 * Deliberately has no knowledge of network requests: reordering calls the
 * supplied `onReorder` callback so each caller can persist it however it
 * needs to (the two pages hit the same PATCH endpoint, just against a
 * different form id).
 */
export function useFormFieldEditor(
  fields: FormField[] | undefined,
  onReorder: (stableKey: string, position: number) => void,
) {
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

  useEffect(() => {
    setFieldOrder(fields?.map((field) => field.stableKey) ?? [])
  }, [fields])

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
    onReorder(stableKey, targetIndex)
  }

  const orderedFields = [...(fields ?? [])].sort((left, right) => {
    const leftIndex = fieldOrder.indexOf(left.stableKey)
    const rightIndex = fieldOrder.indexOf(right.stableKey)
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex)
  })

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

  // Cancel out of editing a field, discarding any pending (unsaved) reorder
  // by resetting fieldOrder back to the canonical order from the query data.
  const cancelEditing = () => {
    setEditingKey(null)
    setFieldOrder(fields?.map((item) => item.stableKey) ?? [])
  }

  return {
    fieldLabel, setFieldLabel,
    fieldType, setFieldType,
    required, setRequired,
    optionsText, setOptionsText,
    ratingMin, setRatingMin,
    ratingMax, setRatingMax,
    weight, setWeight,
    optionScores, setOptionScores,
    trueScore, setTrueScore,
    falseScore, setFalseScore,
    addingField, setAddingField,

    editingKey, setEditingKey,
    editingLabel, setEditingLabel,
    editingType, setEditingType,
    editingRequired, setEditingRequired,
    editingOptionsText, setEditingOptionsText,
    editingRatingMin, setEditingRatingMin,
    editingRatingMax, setEditingRatingMax,
    editingWeight, setEditingWeight,
    editingOptionScores, setEditingOptionScores,
    editingTrueScore, setEditingTrueScore,
    editingFalseScore, setEditingFalseScore,

    fieldOrder, setFieldOrder,
    draggedFieldKey, setDraggedFieldKey,
    dragOverFieldKey, setDragOverFieldKey,
    previewAnswers, setPreviewAnswers,

    beginEditingField,
    moveFieldTo,
    orderedFields,
    resetNewField,
    cancelEditing,
  }
}
