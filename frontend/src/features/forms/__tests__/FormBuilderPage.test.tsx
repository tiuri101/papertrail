import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FormBuilderPage } from '../FormBuilderPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function openNewFieldDraft() {
  fireEvent.click(screen.getByRole('button', { name: 'Add form field' }))
  return screen.getByLabelText('Label')
}

describe('FormBuilderPage', () => {
  it('creates a project form and adds a required typed field', async () => {
    const forms: Array<{ id: string; name: string; kind: string; activeVersionId: string | null }> = []
    const fields: Array<{ id: string; stableKey: string; label: string; fieldType: string; required: boolean; isArchived: boolean }> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Urban review extraction' } })
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'extraction' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Form' }))

    await waitFor(() => expect(screen.getByLabelText('Form to edit')).toHaveValue('form-1'))
    expect(screen.queryByRole('heading', { name: 'Add Field' })).not.toBeInTheDocument()
    fireEvent.change(openNewFieldDraft(), { target: { value: 'Main finding' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'long_text' } })
    fireEvent.click(screen.getByLabelText('Required'))
    fireEvent.click(screen.getByRole('button', { name: 'Save Field' }))

    const fieldCard = (await screen.findByText('Main finding', { selector: 'details strong' })).closest('details')!
    expect(fieldCard).toHaveClass('llm-schema-field', 'form-editor-field')
    expect(within(fieldCard).getByText('Long text')).toBeInTheDocument()
    expect(within(fieldCard).getByText('Required')).toBeInTheDocument()
    const addButton = screen.getByRole('button', { name: 'Add form field' })
    expect(Array.from(fieldCard.parentElement!.children).indexOf(addButton)).toBeGreaterThan(
      Array.from(fieldCard.parentElement!.children).indexOf(fieldCard),
    )
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
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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
    fireEvent.change(openNewFieldDraft(), { target: { value: 'Study design' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'single_select' } })
    fireEvent.change(screen.getByLabelText('Options (one per line)'), { target: { value: 'Experimental\nObservational' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Field' }))

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
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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
    fireEvent.change(openNewFieldDraft(), { target: { value: 'Study design' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'single_select' } })
    fireEvent.change(screen.getByLabelText('Options (one per line)'), { target: { value: 'Strong\nWeak' } })
    fireEvent.change(screen.getByLabelText('Strong'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Weak'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Field' }))

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
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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
    fireEvent.change(openNewFieldDraft(), { target: { value: 'Overall rank' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'rating' } })
    fireEvent.change(screen.getByLabelText('Scale minimum'), { target: { value: '0' } })
    fireEvent.change(screen.getByLabelText('Scale maximum'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Field' }))

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
    const fieldCard = (await screen.findByText('Overall rank', { selector: 'strong' })).closest('details')!
    expect(within(fieldCard).getByText('Rating (0-10)')).toBeInTheDocument()
  })

  it('renders a live preview of the active fields', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'short_text', required: true, isArchived: false, options: [] },
    ]
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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

  it('edits a field label and required state together', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'short_text', required: false, isArchived: false, options: [] },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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

    fireEvent.click((await screen.findByText('Main finding', { selector: 'strong' })).closest('summary')!)
    fireEvent.change(screen.getByLabelText('Edit label for Main finding'), { target: { value: 'Primary outcome' } })
    fireEvent.click(screen.getByLabelText('Edit required for Main finding'))
    expect(screen.queryByRole('button', { name: /Change Type/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
        label: 'Primary outcome',
        required: true,
        position: 0,
        options: [],
        scoring: {},
      })
    })
  })

  it('edits a field type through the unified editor without a separate Change Type action', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Sample size', fieldType: 'short_text', required: true, isArchived: false, options: [] },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/forms/form-1/fields/stable-1/replace') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const replacement = { id: 'field-2', stableKey: 'stable-2', ...body, isArchived: false, options: [] }
        fields[0] = { ...fields[0], isArchived: true }
        fields.push(replacement)
        return jsonResponse(replacement)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })
    fireEvent.click((await screen.findByText('Sample size', { selector: 'strong' })).closest('summary')!)
    fireEvent.change(screen.getByLabelText('Edit type for Sample size'), { target: { value: 'number' } })
    expect(screen.queryByRole('button', { name: /Change Type/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const replaceCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields/stable-1/replace') && init?.method === 'POST')
      expect(replaceCall).toBeTruthy()
      expect(JSON.parse(String(replaceCall?.[1]?.body))).toEqual({
        label: 'Sample size',
        fieldType: 'number',
        required: true,
        position: 0,
        options: [],
        scoring: {},
      })
    })
  })

  it('drags a field card into a new order and saves its edited options', async () => {
    const fields = [
      {
        id: 'field-1', stableKey: 'stable-1', label: 'Study designs', fieldType: 'multiple_select',
        required: false, position: 0, isArchived: false, options: ['Experimental', 'Observational'], scoring: {},
      },
      {
        id: 'field-2', stableKey: 'stable-2', label: 'Notes', fieldType: 'long_text',
        required: false, position: 1, isArchived: false, options: [], scoring: {},
      },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        if (Object.keys(body).length === 1 && body.position === 1) {
          const [moved] = fields.splice(0, 1)
          fields.splice(1, 0, moved)
        }
        return jsonResponse({ ...fields.find((field) => field.stableKey === 'stable-1'), ...body })
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })
    const fieldSummary = (await screen.findByText('Study designs', { selector: 'strong' })).closest('summary')!
    const fieldCard = fieldSummary.closest('details')!
    fireEvent.click(fieldSummary)
    expect(fieldCard).toHaveAttribute('open')
    fireEvent.click(fieldSummary)
    expect(fieldCard).not.toHaveAttribute('open')
    fireEvent.click(fieldSummary)

    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    const optionsInput = screen.getByLabelText('Edit options for Study designs')
    expect(optionsInput).toHaveValue('Experimental\nObservational')
    fireEvent.change(optionsInput, { target: { value: 'Experimental\nQuasi-experimental' } })

    const transferred: Record<string, string> = {}
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: (type: string, value: string) => { transferred[type] = value },
      getData: (type: string) => transferred[type] ?? '',
    } as unknown as DataTransfer
    const studyHandle = screen.getByRole('button', { name: 'Reorder Study designs' })
    const notesCard = screen.getByText('Notes', { selector: 'details strong' }).closest('details')!
    expect(screen.queryByRole('button', { name: 'Move Up' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Move Down' })).not.toBeInTheDocument()
    fireEvent.dragStart(studyHandle, { dataTransfer })
    fireEvent.dragOver(notesCard, { dataTransfer })
    fireEvent.drop(notesCard, { dataTransfer })

    await waitFor(() => {
      const reorderCall = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/forms/form-1/fields/stable-1')
          && init?.method === 'PATCH'
          && JSON.parse(String(init.body)).position === 1
          && Object.keys(JSON.parse(String(init.body))).length === 1
      ))
      expect(reorderCall).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const updateCall = fetchMock.mock.calls.find(([input, init]) => (
        String(input).endsWith('/forms/form-1/fields/stable-1')
          && init?.method === 'PATCH'
          && 'options' in JSON.parse(String(init.body))
      ))
      expect(updateCall).toBeTruthy()
      expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({
        label: 'Study designs',
        required: false,
        position: 1,
        options: ['Experimental', 'Quasi-experimental'],
        scoring: {},
      })
    })
  })

  it('archives a field after confirmation', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'short_text', required: false, isArchived: false, options: [] },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        fields[0] = { ...fields[0], ...body, isArchived: true }
        return jsonResponse(fields[0])
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/quality-config')) return jsonResponse({ enabled: false, mode: 'both', aggregation: 'sum' })
      return jsonResponse([{ id: 'form-1', name: 'Extraction', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('option', { name: 'Extraction (extraction)' })
    fireEvent.change(screen.getByLabelText('Form to edit'), { target: { value: 'form-1' } })

    fireEvent.click((await screen.findByText('Main finding', { selector: 'strong' })).closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Field' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ archive: true })
    })
    const fieldCard = (await screen.findByText('Main finding', { selector: 'strong' })).closest('details')!
    await waitFor(() => expect(within(fieldCard).getByText('Archived')).toBeInTheDocument())
  })

  it('starts a new form from a template and saves a form as a template', async () => {
    const forms: Array<{ id: string; name: string; kind: string; activeVersionId: string | null }> = []
    const templates = [{ id: 'template-1', name: 'General extraction', kind: 'extraction', isTemplate: true, activeVersionId: 'v1' }]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
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

  it('lets an administrator inspect, rename, and remove a template', async () => {
    let templates = [{ id: 'template-1', name: 'General extraction', kind: 'extraction', isTemplate: true, activeVersionId: 'v1' }]
    const fields = [{ id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'long_text', required: true, position: 0, isArchived: false, options: [], scoring: {} }]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/auth/session')) {
        return jsonResponse({ user: { id: 'admin', isAdmin: true }, csrfToken: 'csrf' })
      }
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/form-templates')) return jsonResponse(templates)
      if (path.endsWith('/forms/template-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/forms/template-1') && init?.method === 'PATCH') {
        templates = [{ ...templates[0], name: JSON.parse(String(init.body)).name }]
        return jsonResponse(templates[0])
      }
      if (path.endsWith('/forms/template-1') && init?.method === 'DELETE') {
        templates = []
        return jsonResponse(undefined, 204)
      }
      if (path.endsWith('/projects/p1/forms')) return jsonResponse([])
      return jsonResponse({})
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    expect(screen.queryByText(/Inspect the fields in any shared template/)).not.toBeInTheDocument()
    const inspectButton = await screen.findByRole('button', { name: 'Inspect & Edit' })
    expect(inspectButton.closest('.form-template-card__actions')).toContainElement(
      screen.getByRole('button', { name: 'Remove' }),
    )
    fireEvent.click(inspectButton)
    await screen.findByDisplayValue('General extraction')
    expect(screen.getByText('Reusable template', { selector: '.form-editor-selection-type' }))
      .toBeInTheDocument()
    expect(document.querySelector('.form-editor-selection-heading h3')).not.toBeInTheDocument()
    expect(await screen.findByText('Main finding', { selector: 'strong' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name', { selector: '.form-editor-rename input' }), {
      target: { value: 'Evidence extraction' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save Name' }))
    await waitFor(() => expect(screen.getAllByRole('heading', { name: 'Evidence extraction' })).not.toHaveLength(0))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Template' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Evidence extraction' })).not.toBeInTheDocument())
    expect(fetchMock.mock.calls.some(([input, init]) => (
      String(input).endsWith('/forms/template-1') && init?.method === 'DELETE'
    ))).toBe(true)
  })

})
