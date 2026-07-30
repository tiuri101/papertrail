import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
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

export function FormBuilderPage() {
  const { projectId = '' } = useParams()
  const queryClient = useQueryClient()
  const [name, setName] = useState('Extraction form')
  const [kind, setKind] = useState('extraction')
  const [selectedForm, setSelectedForm] = useState('')
  const [fieldLabel, setFieldLabel] = useState('')
  const [fieldType, setFieldType] = useState('long_text')
  const [required, setRequired] = useState(false)

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
  const addField = useMutation({
    mutationFn: () => apiRequest<FormField>(
      `/api/v1/forms/${selectedForm}/fields`,
      {
        method: 'POST',
        body: JSON.stringify({
          label: fieldLabel,
          fieldType,
          required,
          options: [],
          scoring: {},
        }),
      },
    ),
    onSuccess: () => {
      setFieldLabel('')
      queryClient.invalidateQueries({
        queryKey: ['form-fields', selectedForm],
      })
    },
  })

  const mutationError = createForm.error ?? addField.error

  return (
    <main className="page">
      <h1>Forms and templates</h1>
      {forms.error ? <p className="error" role="alert">{forms.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
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
