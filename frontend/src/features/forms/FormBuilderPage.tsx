import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'

interface ReviewForm {
  id: string
  name: string
  kind: string
  activeVersionId: string | null
}

interface FormField {
  id: string
  stableKey: string
  label: string
  fieldType: string
  required: boolean
  isArchived: boolean
}

interface QualityConfig {
  enabled: boolean
  mode: string
  aggregation: string
}

const fieldTypes = [
  'short_text',
  'long_text',
  'number',
  'checkbox',
  'single_select',
  'multiple_select',
  'date',
  'url',
  'rating',
]

const selectFieldTypes = new Set(['single_select', 'multiple_select'])
const weightedFieldTypes = new Set(['number', 'rating'])

function parseOptions(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
}

function buildScoring(params: {
  isQualityForm: boolean
  fieldType: string
  weight: string
  options: string[]
  optionScores: Record<string, string>
  trueScore: string
  falseScore: string
}): Record<string, unknown> {
  if (!params.isQualityForm) return {}
  if (weightedFieldTypes.has(params.fieldType)) {
    return params.weight.trim() ? { weight: Number(params.weight) } : {}
  }
  if (params.fieldType === 'single_select') {
    const values: Record<string, number> = {}
    for (const option of params.options) {
      const raw = params.optionScores[option]
      if (raw !== undefined && raw.trim() !== '') values[option] = Number(raw)
    }
    return Object.keys(values).length ? { values } : {}
  }
  if (params.fieldType === 'checkbox') {
    const scoring: Record<string, number> = {}
    if (params.trueScore.trim()) scoring['true'] = Number(params.trueScore)
    if (params.falseScore.trim()) scoring['false'] = Number(params.falseScore)
    return scoring
  }
  return {}
}

export function FormBuilderPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const [name, setName] = useState('Extraction form')
  const [kind, setKind] = useState('extraction')
  const [selectedForm, setSelectedForm] = useState('')
  const [fieldLabel, setFieldLabel] = useState('')
  const [fieldType, setFieldType] = useState('long_text')
  const [required, setRequired] = useState(false)
  const [optionsText, setOptionsText] = useState('')
  const [weight, setWeight] = useState('')
  const [optionScores, setOptionScores] = useState<Record<string, string>>({})
  const [trueScore, setTrueScore] = useState('')
  const [falseScore, setFalseScore] = useState('')

  const [qcEnabled, setQcEnabled] = useState(false)
  const [qcMode, setQcMode] = useState('both')
  const [qcAggregation, setQcAggregation] = useState('sum')

  const forms = useQuery({
    queryKey: ['forms', projectId],
    queryFn: () => apiRequest<ReviewForm[]>(
      `/api/v1/projects/${projectId}/forms`,
    ),
  })
  const fields = useQuery({
    queryKey: ['form-fields', selectedForm],
    queryFn: () => apiRequest<FormField[]>(
      `/api/v1/forms/${selectedForm}/fields`,
    ),
    enabled: Boolean(selectedForm),
  })
  const qualityConfig = useQuery({
    queryKey: ['quality-config', projectId],
    queryFn: () => apiRequest<QualityConfig>(
      `/api/v1/projects/${projectId}/quality-config`,
    ),
    enabled: Boolean(projectId),
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

  const createForm = useMutation({
    mutationFn: () => apiRequest<ReviewForm>(
      `/api/v1/projects/${projectId}/forms`,
      {
        method: 'POST',
        body: JSON.stringify({ name, kind }),
      },
    ),
    onSuccess: (form) => {
      setSelectedForm(form.id)
      queryClient.invalidateQueries({ queryKey: ['forms', projectId] })
    },
  })
  const selectedFormKind = forms.data?.find((form) => form.id === selectedForm)?.kind
  const isQualityForm = selectedFormKind === 'quality'
  const showOptions = selectFieldTypes.has(fieldType)
  const options = parseOptions(optionsText)

  const addField = useMutation({
    mutationFn: () => apiRequest<FormField>(
      `/api/v1/forms/${selectedForm}/fields`,
      {
        method: 'POST',
        body: JSON.stringify({
          label: fieldLabel,
          fieldType,
          required,
          options: showOptions ? options : [],
          scoring: buildScoring({ isQualityForm, fieldType, weight, options, optionScores, trueScore, falseScore }),
        }),
      },
    ),
    onSuccess: () => {
      setFieldLabel('')
      setOptionsText('')
      setWeight('')
      setOptionScores({})
      setTrueScore('')
      setFalseScore('')
      queryClient.invalidateQueries({
        queryKey: ['form-fields', selectedForm],
      })
    },
  })
  const saveQualityConfig = useMutation({
    mutationFn: () => apiRequest(
      `/api/v1/projects/${projectId}/quality-config`,
      {
        method: 'PUT',
        body: JSON.stringify({ enabled: qcEnabled, mode: qcMode, aggregation: qcAggregation }),
      },
    ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quality-config', projectId] }),
  })

  const mutationError = createForm.error ?? addField.error

  return (
    <main className="page">
      <h1>Forms and templates</h1>
      {forms.error ? <p className="error" role="alert">{forms.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      <section className="card">
        <h2>Quality assessment settings</h2>
        {qualityConfig.error ? <p className="error" role="alert">{qualityConfig.error.message}</p> : null}
        {qualityConfig.isLoading ? <p>Loading…</p> : (
          <form onSubmit={(event) => { event.preventDefault(); saveQualityConfig.mutate() }}>
            <label>
              <input
                type="checkbox"
                checked={qcEnabled}
                onChange={(event) => setQcEnabled(event.target.checked)}
              />
              Enable quality assessment
            </label>
            <label>
              Mode
              <select value={qcMode} onChange={(event) => setQcMode(event.target.value)}>
                <option value="qualitative">Qualitative only</option>
                <option value="numeric">Numerical scoring only</option>
                <option value="both">Both</option>
              </select>
            </label>
            <label>
              Aggregation
              <select value={qcAggregation} onChange={(event) => setQcAggregation(event.target.value)}>
                <option value="sum">Simple sum</option>
                <option value="average">Average</option>
                <option value="weighted_average">Weighted average</option>
              </select>
            </label>
            {saveQualityConfig.error ? <p className="error" role="alert">{saveQualityConfig.error.message}</p> : null}
            <button type="submit" disabled={saveQualityConfig.isPending}>Save quality settings</button>
          </form>
        )}
      </section>
      <section className="card">
        <h2>Create project form</h2>
        <form onSubmit={(event) => { event.preventDefault(); createForm.mutate() }}>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Kind
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="extraction">Extraction</option>
              <option value="quality">Quality assessment</option>
            </select>
          </label>
          <button type="submit" disabled={createForm.isPending}>Create form</button>
        </form>
      </section>
      <label>
        Active form
        <select
          value={selectedForm}
          onChange={(event) => setSelectedForm(event.target.value)}
        >
          <option value="">Select a form</option>
          {forms.data?.map((form) => (
            <option key={form.id} value={form.id}>
              {form.name} ({form.kind})
            </option>
          ))}
        </select>
      </label>
      {selectedForm ? (
        <section className="card">
          <h2>Add field</h2>
          <form onSubmit={(event) => { event.preventDefault(); addField.mutate() }}>
            <label>
              Label
              <input
                value={fieldLabel}
                onChange={(event) => setFieldLabel(event.target.value)}
                required
              />
            </label>
            <label>
              Type
              <select
                value={fieldType}
                onChange={(event) => setFieldType(event.target.value)}
              >
                {fieldTypes.map((type) => (
                  <option key={type} value={type}>{type}</option>
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
            {isQualityForm && weightedFieldTypes.has(fieldType) ? (
              <label>
                Score weight
                <input
                  type="number"
                  value={weight}
                  onChange={(event) => setWeight(event.target.value)}
                />
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
            <button type="submit" disabled={addField.isPending}>Add field</button>
          </form>
          <h3>Fields</h3>
          {fields.error ? <p className="error" role="alert">{fields.error.message}</p> : null}
          <ul>
            {fields.data?.map((field) => (
              <li key={field.id}>
                {field.label} — {field.fieldType}
                {field.required ? ' — required' : ''}
                {field.isArchived ? ' — archived' : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  )
}
