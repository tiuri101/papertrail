import { Button } from '../../components/Button'
import { IconCheckCircle } from '../../components/icons'
import {
  fieldTypeLabels,
  fieldTypes,
  weightedFieldTypes,
} from './fieldTypes'

// The "add a new field" draft card shown inline in the field list while a
// new field is being configured. Shared between FormBuilderPage and
// FormFieldsPanel — identical markup in both, only the surrounding gating
// condition (readonly template vs. inline-add mode) differs per caller.
export function NewFieldDraftCard({
  fieldLabel,
  fieldType,
  required,
  optionsText,
  ratingMin,
  ratingMax,
  weight,
  optionScores,
  trueScore,
  falseScore,
  isQualityForm,
  showOptions,
  showRatingScale,
  options,
  onFieldLabelChange,
  onFieldTypeChange,
  onRequiredChange,
  onOptionsTextChange,
  onRatingMinChange,
  onRatingMaxChange,
  onWeightChange,
  onOptionScoreChange,
  onTrueScoreChange,
  onFalseScoreChange,
  onSubmit,
  onCancel,
  saving,
}: {
  fieldLabel: string
  fieldType: string
  required: boolean
  optionsText: string
  ratingMin: string
  ratingMax: string
  weight: string
  optionScores: Record<string, string>
  trueScore: string
  falseScore: string
  isQualityForm: boolean
  showOptions: boolean
  showRatingScale: boolean
  options: string[]
  onFieldLabelChange: (value: string) => void
  onFieldTypeChange: (value: string) => void
  onRequiredChange: (value: boolean) => void
  onOptionsTextChange: (value: string) => void
  onRatingMinChange: (value: string) => void
  onRatingMaxChange: (value: string) => void
  onWeightChange: (value: string) => void
  onOptionScoreChange: (option: string, value: string) => void
  onTrueScoreChange: (value: string) => void
  onFalseScoreChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  saving: boolean
}) {
  return (
    <div className="llm-schema-field form-editor-field form-editor-field--draft">
      <div className="llm-schema-field__summary">
        <span className="llm-schema-field__title">
          <strong>{fieldLabel.trim() || 'New field'}</strong>
          <span className="status-badge">{fieldTypeLabels[fieldType] ?? fieldType}</span>
          {required ? <span className="status-badge">Required</span> : null}
        </span>
        <span className="llm-schema-field__mapping">
          {required ? 'Reviewers must complete this field' : 'Optional for reviewers'}
        </span>
        <span className="llm-schema-field__preview">Configure the new response field below.</span>
      </div>
      <form
        className="llm-schema-field__content form-editor-field__draft-form"
        onSubmit={(event) => { event.preventDefault(); onSubmit() }}
      >
        <label>
          Label
          <input
            value={fieldLabel}
            onChange={(event) => onFieldLabelChange(event.target.value)}
            autoFocus
            required
          />
        </label>
        <label>
          Type
          <select value={fieldType} onChange={(event) => onFieldTypeChange(event.target.value)}>
            {fieldTypes.map((type) => (
              <option key={type} value={type}>{fieldTypeLabels[type] ?? type}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={required}
            onChange={(event) => onRequiredChange(event.target.checked)}
          />
          Required
        </label>
        {showOptions ? (
          <label>
            Options (one per line)
            <textarea
              value={optionsText}
              onChange={(event) => onOptionsTextChange(event.target.value)}
              rows={4}
            />
          </label>
        ) : null}
        {showRatingScale ? (
          <div className="form-editor-field__settings-row">
            <label>
              Scale minimum
              <input
                type="number"
                value={ratingMin}
                onChange={(event) => onRatingMinChange(event.target.value)}
              />
            </label>
            <label>
              Scale maximum
              <input
                type="number"
                value={ratingMax}
                onChange={(event) => onRatingMaxChange(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        {isQualityForm && weightedFieldTypes.has(fieldType) ? (
          <label>
            Score weight
            <input type="number" value={weight} onChange={(event) => onWeightChange(event.target.value)} />
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
                  onChange={(event) => onOptionScoreChange(option, event.target.value)}
                />
              </label>
            ))}
          </fieldset>
        ) : null}
        {isQualityForm && fieldType === 'checkbox' ? (
          <div className="form-editor-field__settings-row">
            <label>
              Score if checked
              <input type="number" value={trueScore} onChange={(event) => onTrueScoreChange(event.target.value)} />
            </label>
            <label>
              Score if unchecked
              <input type="number" value={falseScore} onChange={(event) => onFalseScoreChange(event.target.value)} />
            </label>
          </div>
        ) : null}
        <div className="toolbar">
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={!fieldLabel.trim()}
          >
            <IconCheckCircle />Save Field
          </Button>
          <button
            type="button"
            className="button-secondary"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
