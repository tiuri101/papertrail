import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FormBuilderPage } from '../FormBuilderPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('FormBuilderPage', () => {
  it('creates a project form and adds a required typed field', async () => {
    const forms: Array<{ id: string; name: string; kind: string; activeVersionId: string | null }> = []
    const fields: Array<{ id: string; stableKey: string; label: string; fieldType: string; required: boolean; isArchived: boolean }> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1/forms') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const form = { id: 'form-1', ...body, activeVersionId: null }
        forms.push(form)
        return jsonResponse(form, 201)
      }
      if (path.endsWith('/forms/form-1/fields') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const field = { id: 'field-1', stableKey: 'stable-1', ...body, isArchived: false }
        fields.push(field)
        return jsonResponse(field, 201)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse(forms)
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Urban review extraction' } })
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'extraction' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Form' }))

    await waitFor(() => expect(screen.getByLabelText('Form to edit')).toHaveValue('form-1'))
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Main finding' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'long_text' } })
    fireEvent.click(screen.getByLabelText('Required'))
    fireEvent.click(screen.getByRole('button', { name: 'Add Field' }))

    const row = (await screen.findByRole('cell', { name: 'Main finding' })).closest('tr')!
    expect(within(row).getByText('Long text')).toBeInTheDocument()
    expect(within(row).getByText('Required')).toBeInTheDocument()
    const fieldCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields') && init?.method === 'POST')
    expect(JSON.parse(String(fieldCall?.[1]?.body))).toEqual({
      label: 'Main finding',
      fieldType: 'long_text',
      required: true,
      options: [],
      scoring: {},
    })
  })

  it('sends the entered options for a single-select field', async () => {
    const fields: Array<{ id: string; stableKey: string; label: string; fieldType: string; required: boolean; isArchived: boolean }> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/forms/form-1/fields') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const field = { id: 'field-1', stableKey: 'stable-1', ...body, isArchived: false }
        fields.push(field)
        return jsonResponse(field, 201)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })
    fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'Study design' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'single_select' } })
    fireEvent.change(screen.getByLabelText('Options (one per line)'), { target: { value: 'Experimental\nObservational' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Field' }))

    await waitFor(() => {
      const fieldCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields') && init?.method === 'POST')
      expect(fieldCall).toBeTruthy()
      expect(JSON.parse(String(fieldCall?.[1]?.body))).toEqual({
        label: 'Study design',
        fieldType: 'single_select',
        required: false,
        options: ['Experimental', 'Observational'],
        scoring: {},
      })
    })
  })

  it('sends per-option scoring for a single-select field on a quality form', async () => {
    const fields: Array<{ id: string; stableKey: string; label: string; fieldType: string; required: boolean; isArchived: boolean }> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/forms/form-1/fields') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const field = { id: 'field-1', stableKey: 'stable-1', ...body, isArchived: false }
        fields.push(field)
        return jsonResponse(field, 201)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Quality', kind: 'quality', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Quality (quality)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })
    fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'Study design' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'single_select' } })
    fireEvent.change(screen.getByLabelText('Options (one per line)'), { target: { value: 'Strong\nWeak' } })
    fireEvent.change(screen.getByLabelText('Strong'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Weak'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Field' }))

    await waitFor(() => {
      const fieldCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields') && init?.method === 'POST')
      expect(fieldCall).toBeTruthy()
      expect(JSON.parse(String(fieldCall?.[1]?.body))).toEqual({
        label: 'Study design',
        fieldType: 'single_select',
        required: false,
        options: ['Strong', 'Weak'],
        scoring: { values: { Strong: 2, Weak: 0 } },
      })
    })
  })

  it('sends a configured scale for a rating field', async () => {
    const fields: Array<{ id: string; stableKey: string; label: string; fieldType: string; required: boolean; isArchived: boolean }> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/forms/form-1/fields') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const field = { id: 'field-1', stableKey: 'stable-1', ...body, isArchived: false }
        fields.push(field)
        return jsonResponse(field, 201)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })
    fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'Overall rank' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'rating' } })
    fireEvent.change(screen.getByLabelText('Scale minimum'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Scale maximum'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Field' }))

    await waitFor(() => {
      const fieldCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields') && init?.method === 'POST')
      expect(fieldCall).toBeTruthy()
      expect(JSON.parse(String(fieldCall?.[1]?.body))).toEqual({
        label: 'Overall rank',
        fieldType: 'rating',
        required: false,
        options: ['0', '10'],
        scoring: {},
      })
    })
    const row = (await screen.findByRole('cell', { name: 'Overall rank' })).closest('tr')!
    expect(within(row).getByText('Rating (0-10)')).toBeInTheDocument()
  })

  it('renders a live preview of the active fields', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'short_text', required: true, isArchived: false, options: [] },
    ]
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })

    await screen.findByText('Preview')
    expect(screen.getByLabelText('Main finding *')).toBeInTheDocument()
  })

  it('edits a field label', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'short_text', required: false, isArchived: false, options: [] },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        fields[0] = { ...fields[0], ...body }
        return jsonResponse(fields[0])
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit label for Main finding'), { target: { value: 'Primary outcome' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ label: 'Primary outcome' })
    })
  })

  it('archives a field after confirmation', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'short_text', required: false, isArchived: false, options: [] },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        fields[0] = { ...fields[0], ...body, isArchived: true }
        return jsonResponse(fields[0])
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ archive: true })
    })
    const row = (await screen.findByRole('cell', { name: 'Main finding' })).closest('tr')!
    await waitFor(() => expect(within(row).getByText('Archived')).toBeInTheDocument())
  })

  it('replaces a field type after confirmation', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Sample size', fieldType: 'short_text', required: true, isArchived: false, options: [] },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/forms/form-1/fields/stable-1/replace') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const replacement = { id: 'field-2', stableKey: 'stable-2', label: body.label, fieldType: body.fieldType, required: body.required, isArchived: false, options: [] }
        fields[0] = { ...fields[0], isArchived: true }
        fields.push(replacement)
        return jsonResponse(replacement, 201)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })

    fireEvent.click(await screen.findByRole('button', { name: 'Change Type…' }))
    fireEvent.change(screen.getByLabelText('New type for Sample size'), { target: { value: 'number' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      const replaceCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields/stable-1/replace') && init?.method === 'POST')
      expect(replaceCall).toBeTruthy()
      expect(JSON.parse(String(replaceCall?.[1]?.body))).toEqual({ fieldType: 'number', label: 'Sample size', required: true })
    })
    await waitFor(() => {
      const rows = screen.getAllByRole('cell', { name: 'Sample size' }).map((cell) => cell.closest('tr')!)
      const activeRow = rows.find((candidate) => within(candidate).queryByText('Number'))
      expect(activeRow).toBeTruthy()
      expect(within(activeRow!).getByText('Required')).toBeInTheDocument()
    })
  })

  it('starts a new form from a template and saves a form as a template', async () => {
    const forms: Array<{ id: string; name: string; kind: string; activeVersionId: string | null }> = []
    const templates = [{ id: 'template-1', name: 'General extraction', kind: 'extraction', isTemplate: true, activeVersionId: 'v1' }]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/form-templates') && (!init || init.method === undefined)) return jsonResponse(templates)
      if (path.endsWith('/projects/p1/forms') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const form = { id: 'form-1', ...body, activeVersionId: 'v1' }
        forms.push(form)
        return jsonResponse(form, 201)
      }
      if (path.endsWith('/forms/form-1/save-as-template') && init?.method === 'POST') {
        return jsonResponse({ id: 'template-2', name: 'Saved template', kind: 'extraction', isTemplate: true, activeVersionId: 'v1' }, 201)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse([])
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse(forms)
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'General extraction' })
    fireEvent.change(screen.getByLabelText('Start from template (optional)'), { target: { value: 'template-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Form' }))

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/projects/p1/forms') && init?.method === 'POST')
      expect(createCall).toBeTruthy()
      expect(JSON.parse(String(createCall?.[1]?.body)).templateId).toBe('template-1')
    })

    await waitFor(() => expect(screen.getByLabelText('Form to edit')).toHaveValue('form-1'))
    fireEvent.click(screen.getByRole('button', { name: 'Save as Template' }))

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/save-as-template') && init?.method === 'POST')
      expect(saveCall).toBeTruthy()
    })
    await screen.findByText('Template saved.')
  })

  it('reads and saves quality assessment settings', async () => {
    let config = { enabled: false, mode: 'both', aggregation: 'sum' }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/quality-config') && init?.method === 'PUT') {
        config = JSON.parse(String(init.body))
        return jsonResponse(config)
      }
      if (path.endsWith('/quality-config')) return jsonResponse(config)
      return jsonResponse([])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    const enabledCheckbox = await screen.findByLabelText('Enable quality assessment')
    expect(enabledCheckbox).not.toBeChecked()

    fireEvent.click(enabledCheckbox)
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'numeric' } })
    fireEvent.change(screen.getByLabelText('Aggregation'), { target: { value: 'weighted_average' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Quality Settings' }))

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/quality-config') && init?.method === 'PUT')
      expect(putCall).toBeTruthy()
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({ enabled: true, mode: 'numeric', aggregation: 'weighted_average' })
    })
  })
})
