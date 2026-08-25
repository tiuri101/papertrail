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
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import { Textarea } from '../../components/Textarea'
import { Button } from '../../components/Button'
import { FieldLabel } from '../../components/FieldLabel'
import { Fieldset } from '../../components/Fieldset'
import { FieldLegend } from '../../components/FieldLegend'

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
      <FieldLabel>
        Label
        <Input
          aria-label={`Edit label for ${field.label}`}
          value={editingLabel}
          onChange={(event) => onEditingLabelChange(event.target.value)}
        />
      </FieldLabel>
      <FieldLabel>
        Type
        <Select
          aria-label={`Edit type for ${field.label}`}
          value={editingType}
          onChange={(event) => onEditingTypeChange(event.target.value)}
        >
          {fieldTypes.map((type) => (
            <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
          ))}
        </Select>
      </FieldLabel>
      <FieldLabel inline>
        <Input
          type="checkbox"
          aria-label={`Edit required for ${field.label}`}
          checked={editingRequired}
          onChange={(event) => onEditingRequiredChange(event.target.checked)}
        />
        Required
      </FieldLabel>
      {selectFieldTypes.has(editingType) ? (
        <FieldLabel>
          Options (one per line)
          <Textarea
            aria-label={`Edit options for ${field.label}`}
            value={editingOptionsText}
            onChange={(event) => onEditingOptionsTextChange(event.target.value)}
            rows={4}
          />
        </FieldLabel>
      ) : null}
      {editingType === 'rating' ? (
        <div className="form-editor-field__settings-row grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <FieldLabel>
            Scale minimum
            <Input
              type="number"
              aria-label={`Edit scale minimum for ${field.label}`}
              value={editingRatingMin}
              onChange={(event) => onEditingRatingMinChange(event.target.value)}
            />
          </FieldLabel>
          <FieldLabel>
            Scale maximum
            <Input
              type="number"
              aria-label={`Edit scale maximum for ${field.label}`}
              value={editingRatingMax}
              onChange={(event) => onEditingRatingMaxChange(event.target.value)}
            />
          </FieldLabel>
        </div>
      ) : null}
      {isQualityForm && weightedFieldTypes.has(editingType) ? (
        <FieldLabel>
          Score weight
          <Input
            type="number"
            aria-label={`Edit score weight for ${field.label}`}
            value={editingWeight}
            onChange={(event) => onEditingWeightChange(event.target.value)}
            className="!w-100"
          />
        </FieldLabel>
      ) : null}
      {isQualityForm && editingType === 'single_select' ? (
        <Fieldset>
          <FieldLegend>Score per option</FieldLegend>
          {editingOptions.length === 0 ? <p className="text-text">Add options above first.</p> : null}
          {editingOptions.map((option) => (
            <FieldLabel key={option}>
              {option}
              <Input
                type="number"
                aria-label={`Edit score for ${option}`}
                value={editingOptionScores[option] ?? ''}
                onChange={(event) => onEditingOptionScoreChange(option, event.target.value)}
              />
            </FieldLabel>
          ))}
        </Fieldset>
      ) : null}
      {isQualityForm && editingType === 'checkbox' ? (
        <div className="form-editor-field__settings-row grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <FieldLabel>
            Score if checked
            <Input
              type="number"
              aria-label={`Edit checked score for ${field.label}`}
              value={editingTrueScore}
              onChange={(event) => onEditingTrueScoreChange(event.target.value)}
            />
          </FieldLabel>
          <FieldLabel>
            Score if unchecked
            <Input
              type="number"
              aria-label={`Edit unchecked score for ${field.label}`}
              value={editingFalseScore}
              onChange={(event) => onEditingFalseScoreChange(event.target.value)}
            />
          </FieldLabel>
        </div>
      ) : null}
      <div className="toolbar flex flex-wrap items-center gap-3 my-5 max-[760px]:gap-2">
        <Button
          type="button"
          disabled={saving}
          onClick={onSave}
        >
          <IconCheckCircle />
          Save
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
      {trailingAction}
    </>
  )
}
