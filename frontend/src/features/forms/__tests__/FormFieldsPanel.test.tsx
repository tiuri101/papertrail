import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FormFieldsPanel } from '../FormFieldsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('FormFieldsPanel', () => {
  it('creates the backing QA form when the first inline scored field is saved', async () => {
    let form: { id: string; name: string; kind: string; isTemplate: boolean; activeVersionId: string | null } | null = null
    const fields: Array<Record<string, unknown>> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path === '/api/v1/form-templates') return jsonResponse([])
      if (path === '/api/v1/projects/p1/forms' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        form = { id: 'quality-1', ...body, isTemplate: false, activeVersionId: null }
        return jsonResponse(form, 201)
      }
      if (path === '/api/v1/projects/p1/forms') return jsonResponse(form ? [form] : [])
      if (path === '/api/v1/forms/quality-1/fields' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const field = { id: 'field-1', stableKey: 'stable-1', position: 0, isArchived: false, ...body }
        fields.push(field)
        return jsonResponse(field, 201)
      }
      if (path === '/api/v1/forms/quality-1/fields') return jsonResponse(fields)
      if (path === '/api/v1/projects/p1/quality-config') {
        return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum', allocationMode: 'claim' })
      }
      return jsonResponse({})
    })

    renderWithProviders(
      <FormFieldsPanel projectId="p1" kind="quality" title="QA Form" inlineAdd />,
    )

    expect(await screen.findByRole('button', { name: 'Add form field' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create Quality Form' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add form field' }))
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input) === '/api/v1/projects/p1/forms' && init?.method === 'POST'
    ))).toBe(false)

    const labelInput = await screen.findByLabelText('Label')
    fireEvent.change(labelInput, { target: { value: 'Risk of bias' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'single_select' } })
    fireEvent.change(screen.getByLabelText('Options (one per line)'), { target: { value: 'Low\nHigh' } })
    fireEvent.change(screen.getByLabelText('Low'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('High'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Field' }))

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([input, init]) => (
        String(input) === '/api/v1/projects/p1/forms' && init?.method === 'POST'
      ))
      expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
        name: 'Quality assessment form',
        kind: 'quality',
      })
      const fieldCall = fetchMock.mock.calls.find(([input, init]) => (
        String(input) === '/api/v1/forms/quality-1/fields' && init?.method === 'POST'
      ))
      expect(JSON.parse(String(fieldCall?.[1]?.body))).toEqual({
        label: 'Risk of bias',
        fieldType: 'single_select',
        required: false,
        options: ['Low', 'High'],
        scoring: { values: { Low: 2, High: 0 } },
      })
    })
  })

  it('deletes an existing QA form when its field list is empty', async () => {
    const form = {
      id: 'quality-1', name: 'Quality assessment form', kind: 'quality',
      isTemplate: false, activeVersionId: 'version-1',
    }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path === '/api/v1/form-templates') return jsonResponse([])
      if (path === '/api/v1/projects/p1/forms') return jsonResponse([form])
      if (path === '/api/v1/forms/quality-1/fields') return jsonResponse([])
      if (path === '/api/v1/forms/quality-1' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      if (path === '/api/v1/projects/p1/quality-config') {
        return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum', allocationMode: 'claim' })
      }
      return jsonResponse({})
    })

    renderWithProviders(
      <FormFieldsPanel projectId="p1" kind="quality" title="QA Form" inlineAdd />,
    )

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => (
        String(input) === '/api/v1/forms/quality-1' && init?.method === 'DELETE'
      ))).toBe(true)
    })
    expect(screen.getByRole('button', { name: 'Add form field' })).toBeInTheDocument()
  })

  it('adds an extraction field from an inline field card in setup mode', async () => {
    const fields = [{
      id: 'field-1', stableKey: 'stable-1', label: 'Study design', fieldType: 'short_text',
      required: false, position: 0, isArchived: false, options: [], scoring: {},
    }]
    const form = { id: 'form-1', name: 'Extraction form', kind: 'extraction', isTemplate: false, activeVersionId: null }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path === '/api/v1/form-templates') return jsonResponse([])
      if (path === '/api/v1/projects/p1/forms') return jsonResponse([form])
      if (path === '/api/v1/forms/form-1/fields' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const field = {
          id: 'field-2', stableKey: 'stable-2', position: 1, isArchived: false, ...body,
        }
        fields.push(field)
        return jsonResponse(field, 201)
      }
      if (path === '/api/v1/forms/form-1/fields') return jsonResponse(fields)
      return jsonResponse({})
    })

    renderWithProviders(
      <FormFieldsPanel projectId="p1" kind="extraction" title="Data Extraction Form" inlineAdd />,
    )

    const existingCard = (await screen.findByText('Study design', { selector: 'strong' })).closest('details')!
    const addButton = screen.getByRole('button', { name: 'Add form field' })
    const fieldList = existingCard.parentElement!
    expect(Array.from(fieldList.children).indexOf(addButton)).toBeGreaterThan(
      Array.from(fieldList.children).indexOf(existingCard),
    )

    fireEvent.click(addButton)
    const labelInput = screen.getByLabelText('Label')
    const draftCard = labelInput.closest('.form-editor-field') as HTMLElement
    expect(draftCard).toHaveClass('form-editor-field--draft')

    fireEvent.change(labelInput, { target: { value: 'Sample size' } })
    fireEvent.change(within(draftCard).getByLabelText('Type'), { target: { value: 'number' } })
    fireEvent.click(within(draftCard).getByLabelText('Required'))
    fireEvent.click(within(draftCard).getByRole('button', { name: 'Save Field' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => (
        String(input) === '/api/v1/forms/form-1/fields' && init?.method === 'POST'
      ))
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        label: 'Sample size',
        fieldType: 'number',
        required: true,
        options: [],
        scoring: {},
      })
    })
  })

  it('reorders setup-wizard fields with a mobile touch drag gesture', async () => {
    const fields = [
      {
        id: 'field-1', stableKey: 'stable-1', label: 'Study design', fieldType: 'short_text',
        required: false, position: 0, isArchived: false, options: [], scoring: {},
      },
      {
        id: 'field-2', stableKey: 'stable-2', label: 'Sample size', fieldType: 'number',
        required: false, position: 1, isArchived: false, options: [], scoring: {},
      },
    ]
    const form = { id: 'form-1', name: 'Extraction form', kind: 'extraction', isTemplate: false, activeVersionId: 'v1' }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path === '/api/v1/form-templates') return jsonResponse([])
      if (path === '/api/v1/projects/p1/forms') return jsonResponse([form])
      if (path === '/api/v1/forms/form-1/fields/stable-1' && init?.method === 'PATCH') {
        const [moved] = fields.splice(0, 1)
        fields.splice(1, 0, moved)
        return jsonResponse({ ...moved, position: 1 })
      }
      if (path === '/api/v1/forms/form-1/fields') return jsonResponse(fields)
      return jsonResponse({})
    })

    renderWithProviders(
      <FormFieldsPanel projectId="p1" kind="extraction" title="Data Extraction Form" inlineAdd />,
    )

    const handle = await screen.findByRole('button', { name: 'Reorder Study design' })
    const targetCard = screen.getByText('Sample size', { selector: 'details strong' }).closest('details')!
    const originalElementFromPoint = document.elementFromPoint
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => targetCard,
    })
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'touch', clientX: 340, clientY: 120 })
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientX: 340, clientY: 240 })
    expect(targetCard).toHaveAttribute('data-drag-over', 'true')
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: 'touch', clientX: 340, clientY: 240 })
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: originalElementFromPoint,
    })

    await waitFor(() => {
      const reorderCall = fetchMock.mock.calls.find(([input, init]) => (
        String(input) === '/api/v1/forms/form-1/fields/stable-1' && init?.method === 'PATCH'
      ))
      expect(JSON.parse(String(reorderCall?.[1]?.body))).toEqual({ position: 1 })
      expect(screen.getAllByRole('button', { name: /^Reorder / }).map((button) => button.getAttribute('aria-label')))
        .toEqual(['Reorder Sample size', 'Reorder Study design'])
    })
  })

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
    expect(fieldCard).toHaveClass('form-editor-field')
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

    const fieldSummary = (await screen.findByText('Sample size', { selector: 'strong' })).closest('summary')!
    const fieldCard = fieldSummary.closest('details')!
    fireEvent.click(fieldSummary)
    expect(fieldCard).toHaveAttribute('open')
    fireEvent.click(fieldSummary)
    expect(fieldCard).not.toHaveAttribute('open')
    expect(screen.queryByLabelText('Edit type for Sample size')).not.toBeInTheDocument()
    fireEvent.click(fieldSummary)
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
