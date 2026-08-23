import type { ReactNode } from 'react'

import { IconCheckCircle } from '../../components/icons'
import {
  fieldTypeLabels,
  fieldTypes,
  parseOptions,
  selectFieldTypes,
  weightedFieldTypes,
} from './fieldTypes'
import type { FormField } from './types'

// The "editing an existing field" form content shown inside a field's
// expanded <details> panel. Shared between FormBuilderPage and
// FormFieldsPanel — identical label/type/required/options/rating/weight/
// scoring inputs and save/cancel toolbar in both. Each caller supplies its
// own trailing action (FormBuilderPage: an "Archive" button; FormFieldsPanel:
// a hard "Remove" button) via `trailingAction`, since the two pages have
// genuinely different delete semantics.
export function FieldEditForm({
  field,
  isQualityForm,
  editingLabel,
  editingType,
  editingRequired,
  editingOptionsText,
  editingRatingMin,
  editingRatingMax,
  editingWeight,
  editingOptionScores,
  editingTrueScore,
  editingFalseScore,
  onEditingLabelChange,
  onEditingTypeChange,
  onEditingRequiredChange,
  onEditingOptionsTextChange,
  onEditingRatingMinChange,
  onEditingRatingMaxChange,
  onEditingWeightChange,
  onEditingOptionScoreChange,
  onEditingTrueScoreChange,
  onEditingFalseScoreChange,
  onSave,
  onCancel,
  saving,
  trailingAction,
}: {
  field: FormField
  isQualityForm: boolean
  editingLabel: string
  editingType: string
  editingRequired: boolean
  editingOptionsText: string
  editingRatingMin: string
  editingRatingMax: string
  editingWeight: string
  editingOptionScores: Record<string, string>
  editingTrueScore: string
  editingFalseScore: string
  onEditingLabelChange: (value: string) => void
  onEditingTypeChange: (value: string) => void
  onEditingRequiredChange: (value: boolean) => void
  onEditingOptionsTextChange: (value: string) => void
  onEditingRatingMinChange: (value: string) => void
  onEditingRatingMaxChange: (value: string) => void
  onEditingWeightChange: (value: string) => void
  onEditingOptionScoreChange: (option: string, value: string) => void
  onEditingTrueScoreChange: (value: string) => void
  onEditingFalseScoreChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  trailingAction?: ReactNode
}) {
  const editingOptions = parseOptions(editingOptionsText)

  return (
    <>
      <label>
        Label
        <input
          aria-label={`Edit label for ${field.label}`}
          value={editingLabel}
          onChange={(event) => onEditingLabelChange(event.target.value)}
        />
      </label>
      <label>
        Type
        <select
          aria-label={`Edit type for ${field.label}`}
          value={editingType}
          onChange={(event) => onEditingTypeChange(event.target.value)}
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
          onChange={(event) => onEditingRequiredChange(event.target.checked)}
        />
        Required
      </label>
      {selectFieldTypes.has(editingType) ? (
        <label>
          Options (one per line)
          <textarea
            aria-label={`Edit options for ${field.label}`}
            value={editingOptionsText}
            onChange={(event) => onEditingOptionsTextChange(event.target.value)}
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
              onChange={(event) => onEditingRatingMinChange(event.target.value)}
            />
          </label>
          <label>
            Scale maximum
            <input
              type="number"
              aria-label={`Edit scale maximum for ${field.label}`}
              value={editingRatingMax}
              onChange={(event) => onEditingRatingMaxChange(event.target.value)}
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
            onChange={(event) => onEditingWeightChange(event.target.value)}
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
                onChange={(event) => onEditingOptionScoreChange(option, event.target.value)}
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
              onChange={(event) => onEditingTrueScoreChange(event.target.value)}
            />
          </label>
          <label>
            Score if unchecked
            <input
              type="number"
              aria-label={`Edit unchecked score for ${field.label}`}
              value={editingFalseScore}
              onChange={(event) => onEditingFalseScoreChange(event.target.value)}
            />
          </label>
        </div>
      ) : null}
      <div className="toolbar">
        <button
          type="button"
          disabled={saving}
          onClick={onSave}
        >
          <IconCheckCircle />
          Save
        </button>
        <button
          type="button"
          className="button-secondary"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {trailingAction}
    </>
  )
}
