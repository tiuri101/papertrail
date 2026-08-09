export interface DynamicFormField {
  stableKey: string
  label: string
  fieldType: string
  required: boolean
  options: string[]
}

interface DynamicFormProps {
  fields: DynamicFormField[]
  value: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  renderAssistance?: (field: DynamicFormField) => ReactNode
}

export function DynamicForm({ fields, value, onChange, renderAssistance }: DynamicFormProps) {
  return (
    <>
      {fields.map((field) => (
        <div className="dynamic-field" key={field.stableKey}>
          <DynamicField
            field={field}
            value={value[field.stableKey]}
            onChange={(next) => onChange(field.stableKey, next)}
          />
          {renderAssistance?.(field)}
        </div>
      ))}
    </>
  )
}

function ratingScale(options: string[]): number[] {
  const [minText, maxText] = options
  const min = Number(minText)
  const max = Number(maxText)
  const hasValidBounds = options.length === 2
    && minText.trim() !== '' && maxText.trim() !== ''
    && Number.isFinite(min) && Number.isFinite(max) && max >= min
  if (!hasValidBounds) return [1, 2, 3, 4, 5]
  return Array.from({ length: max - min + 1 }, (_, index) => min + index)
}

function DynamicField({ field, value, onChange }: {
  field: DynamicFormField
  value: unknown
  onChange: (value: unknown) => void
}) {
  const labelText = field.required ? `${field.label} *` : field.label

  switch (field.fieldType) {
    case 'short_text':
      return (
        <label>
          {labelText}
          <input
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            required={field.required}
          />
        </label>
      )
    case 'long_text':
      return (
        <label>
          {labelText}
          <textarea
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            required={field.required}
          />
        </label>
      )
    case 'number':
      return (
        <label>
          {labelText}
          <input
            type="number"
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
            required={field.required}
          />
        </label>
      )
    case 'checkbox':
      return (
        <label>
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(event) => onChange(event.target.checked)}
          />
          {labelText}
        </label>
      )
    case 'single_select':
      return (
        <label>
          {labelText}
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value || null)}
            required={field.required}
          >
            <option value="">Select…</option>
            {field.options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      )
    case 'multiple_select': {
      const selected = Array.isArray(value) ? value as string[] : []
      return (
        <fieldset>
          <legend>{labelText}</legend>
          {field.options.map((option) => (
            <label key={option}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...selected, option]
                    : selected.filter((item) => item !== option)
                  onChange(next)
                }}
              />
              {option}
            </label>
          ))}
        </fieldset>
      )
    }
    case 'date':
      return (
        <DateField
          label={labelText}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          required={field.required}
        />
      )
    case 'url':
      return (
        <label>
          {labelText}
          <input
            type="url"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            required={field.required}
          />
        </label>
      )
    case 'rating':
      return (
        <label>
          {labelText}
          <select
            value={value === null || value === undefined ? '' : String(value)}
            onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
            required={field.required}
          >
            <option value="">Select a rating…</option>
            {ratingScale(field.options).map((rating) => (
              <option key={rating} value={rating}>{rating}</option>
            ))}
          </select>
        </label>
      )
    default:
      return null
  }
}
import type { ReactNode } from 'react'
import { DateField } from '../../components/DateField'
