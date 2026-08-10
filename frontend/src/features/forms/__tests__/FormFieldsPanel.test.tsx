import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FormFieldsPanel } from '../FormFieldsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('FormFieldsPanel', () => {
  it('creates the extraction form and adds a required field', async () => {
    const fields: Array<{ id: string; stableKey: string; label: string; fieldType: string; required: boolean; isArchived: boolean; options: string[] }> = []
    let form: { id: string; name: string; kind: string; isTemplate: boolean; activeVersionId: string | null } | null = null

    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path === '/api/v1/form-templates') return jsonResponse([])
      if (path === '/api/v1/projects/p1/forms' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        form = { id: 'form-1', name: body.name, kind: body.kind, isTemplate: false, activeVersionId: null }
        return jsonResponse(form, 201)
      }
      if (path === '/api/v1/projects/p1/forms') return jsonResponse(form ? [form] : [])
      if (path === '/api/v1/forms/form-1/fields' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const field = { id: 'field-1', stableKey: 'stable-1', ...body, isArchived: false }
        fields.push(field)
        return jsonResponse(field, 201)
      }
      if (path === '/api/v1/forms/form-1/fields') return jsonResponse(fields)
      return jsonResponse({})
    })

    renderWithProviders(
      <FormFieldsPanel projectId="p1" kind="extraction" title="Data Extraction Form" />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Create Extraction Form' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input) === '/api/v1/projects/p1/forms' && init?.method === 'POST')
      expect(call).toBeDefined()
    })

    fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'Sample size' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'number' } })
    fireEvent.click(screen.getByLabelText('Required'))
    fireEvent.click(screen.getByRole('button', { name: 'Add Field' }))

    const fieldCard = (await screen.findByText('Sample size', { selector: 'strong' })).closest('details')!
    expect(fieldCard).toHaveClass('llm-schema-field', 'form-editor-field')
    expect(within(fieldCard).getByText('Number')).toBeInTheDocument()
    expect(within(fieldCard).getByText('Required')).toBeInTheDocument()

    const fieldCall = fetchMock.mock.calls.find(([input, init]) => String(input) === '/api/v1/forms/form-1/fields' && init?.method === 'POST')
    expect(JSON.parse(String(fieldCall?.[1]?.body))).toEqual({
      label: 'Sample size',
      fieldType: 'number',
      required: true,
      options: [],
      scoring: {},
    })
  })

  it('removes a field outright and edits its type and required flag in place', async () => {
    const fields: Array<{ id: string; stableKey: string; label: string; fieldType: string; required: boolean; isArchived: boolean; options: string[] }> = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Sample size', fieldType: 'short_text', required: false, isArchived: false, options: [] },
    ]
    const form = { id: 'form-1', name: 'Extraction form', kind: 'extraction', isTemplate: false, activeVersionId: 'v1' }

    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path === '/api/v1/form-templates') return jsonResponse([])
      if (path === '/api/v1/projects/p1/forms') return jsonResponse([form])
      if (path === '/api/v1/forms/form-1/fields' && (!init || init.method === undefined)) return jsonResponse(fields)
      if (path === '/api/v1/forms/form-1/fields/stable-1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        Object.assign(fields[0], body)
        return jsonResponse(fields[0])
      }
      if (path === '/api/v1/forms/form-1/fields/stable-1' && init?.method === 'DELETE') {
        fields.splice(0, 1)
        return new Response(null, { status: 204 })
      }
      return jsonResponse({})
    })

    renderWithProviders(
      <FormFieldsPanel projectId="p1" kind="extraction" title="Data Extraction Form" />,
    )

    fireEvent.click((await screen.findByText('Sample size', { selector: 'strong' })).closest('summary')!)
    fireEvent.change(screen.getByLabelText('Edit type for Sample size'), { target: { value: 'number' } })
    fireEvent.click(screen.getByLabelText('Edit required for Sample size'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([reqInput, init]) => String(reqInput) === '/api/v1/forms/form-1/fields/stable-1' && init?.method === 'PATCH')
      expect(call).toBeDefined()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        label: 'Sample size',
        fieldType: 'number',
        required: true,
        position: 0,
        options: [],
        scoring: {},
      })
    })

    fireEvent.click((await screen.findByText('Sample size', { selector: 'strong' })).closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Field' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([reqInput, init]) => String(reqInput) === '/api/v1/forms/form-1/fields/stable-1' && init?.method === 'DELETE')
      expect(call).toBeDefined()
    })
    expect(screen.queryByText('Archive')).not.toBeInTheDocument()
  })

  it('shows quality assessment settings and scoring inputs for the QA form', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path === '/api/v1/form-templates') return jsonResponse([])
      if (path === '/api/v1/projects/p1/forms') return jsonResponse([])
      if (path === '/api/v1/projects/p1/quality-config') return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse({})
    })

    renderWithProviders(
      <FormFieldsPanel projectId="p1" kind="quality" title="Quality Assessment Form (optional)" />,
    )

    expect(await screen.findByLabelText('Enable quality assessment')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Quality Form' })).toBeInTheDocument()
  })
})
