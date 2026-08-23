import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FormBuilderPage } from '../FormBuilderPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function qualityConfigResponse(enabled: boolean) {
  return jsonResponse({ enabled, mode: 'both', aggregation: 'sum' })
}

function openNewFieldDraft(sectionHeading: string) {
  const section = screen.getByRole('heading', { name: new RegExp(sectionHeading) }).closest('.form-kind-section') as HTMLElement
  fireEvent.click(within(section).getByRole('button', { name: 'Add form field' }))
  return within(section).getByLabelText('Label')
}

describe('FormBuilderPage', () => {
  it('shows both form sections directly, with no dropdown or add-form button', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(false)
      return jsonResponse([])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    expect(await screen.findByRole('heading', { name: /Extraction Form/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Quality Assessment Form/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('Form to edit')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Kind')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create Form' })).not.toBeInTheDocument()
  })

  it('warns that an empty extraction form is required, but not an empty quality form when quality assessment is disabled', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(false)
      return jsonResponse([])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('heading', { name: /Extraction Form/ })
    expect(await screen.findByText(/Data extraction is a required pipeline step/)).toBeInTheDocument()
    expect(screen.queryByText(/Quality assessment is enabled for this project/)).not.toBeInTheDocument()
  })

  it('warns about an empty quality form once quality assessment is enabled', async () => {
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(true)
      return jsonResponse([])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    expect(await screen.findByText(/Quality assessment is enabled for this project/)).toBeInTheDocument()
  })

  it('creates the extraction form implicitly by adding its first field, with no separate create-form step', async () => {
    const forms: Array<{ id: string; name: string; kind: string; activeVersionId: string | null }> = []
    const fields: Array<{ id: string; stableKey: string; label: string; fieldType: string; required: boolean; isArchived: boolean }> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(false)
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
      return jsonResponse(forms)
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    await screen.findByRole('heading', { name: /Extraction Form/ })
    fireEvent.change(openNewFieldDraft('Extraction Form'), { target: { value: 'Main finding' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'long_text' } })
    fireEvent.click(screen.getByLabelText('Required'))
    fireEvent.click(screen.getByRole('button', { name: 'Save Field' }))

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([callInput, callInit]) => (
        String(callInput).endsWith('/projects/p1/forms') && callInit?.method === 'POST'
      ))
      expect(createCall).toBeTruthy()
      expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({ name: 'Extraction form', kind: 'extraction' })
    })
    const fieldCall = fetchMock.mock.calls.find(([callInput, callInit]) => (
      String(callInput).endsWith('/forms/form-1/fields') && callInit?.method === 'POST'
    ))
    expect(fieldCall).toBeTruthy()
    expect(JSON.parse(String(fieldCall?.[1]?.body))).toEqual({
      label: 'Main finding',
      fieldType: 'long_text',
      required: true,
      options: [],
      scoring: {},
    })
    const fieldCard = (await screen.findByText('Main finding', { selector: 'details strong' })).closest('details')!
    expect(fieldCard).toHaveAttribute('data-ui', 'form-editor-field')
  })

  it('starts an extraction form from a template', async () => {
    const templates = [{ id: 'template-1', name: 'General extraction', kind: 'extraction', isTemplate: true, activeVersionId: 'v1' }]
    const forms: Array<{ id: string; name: string; kind: string; templateId?: string; activeVersionId: string | null }> = []
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(false)
      if (path.endsWith('/form-templates')) return jsonResponse(templates)
      if (path.endsWith('/projects/p1/forms') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const form = { id: 'form-1', ...body, activeVersionId: 'v1' }
        forms.push(form)
        return jsonResponse(form, 201)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse([])
      return jsonResponse(forms)
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    const extractionSection = (await screen.findByRole('heading', { name: /Extraction Form/ })).closest('.form-kind-section') as HTMLElement
    fireEvent.change(within(extractionSection).getByLabelText('Start from a template'), { target: { value: 'template-1' } })

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find(([callInput, callInit]) => (
        String(callInput).endsWith('/projects/p1/forms') && callInit?.method === 'POST'
      ))
      expect(createCall).toBeTruthy()
      expect(JSON.parse(String(createCall?.[1]?.body)).templateId).toBe('template-1')
    })
  })

  it('edits an existing field and archives it', async () => {
    const fields = [
      { id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'short_text', required: false, isArchived: false, options: [] },
    ]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(false)
      if (path.endsWith('/forms/form-1/fields/stable-1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        fields[0] = { ...fields[0], ...body }
        return jsonResponse(fields[0])
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse(fields)
      return jsonResponse([{ id: 'form-1', name: 'Extraction form', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    fireEvent.click((await screen.findByText('Main finding', { selector: 'strong' })).closest('summary')!)
    fireEvent.change(screen.getByLabelText('Edit label for Main finding'), { target: { value: 'Primary outcome' } })
    fireEvent.click(screen.getByLabelText('Edit required for Main finding'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([callInput, callInit]) => (
        String(callInput).endsWith('/forms/form-1/fields/stable-1') && callInit?.method === 'PATCH'
      ))
      expect(patchCall).toBeTruthy()
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
        label: 'Primary outcome', required: true, position: 0, options: [], scoring: {},
      })
    })

    fireEvent.click((await screen.findByText('Primary outcome', { selector: 'strong' })).closest('summary')!)
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Archive Field' }))
    await waitFor(() => {
      const archiveCall = fetchMock.mock.calls.find(([callInput, callInit]) => (
        String(callInput).endsWith('/forms/form-1/fields/stable-1') && callInit?.method === 'PATCH'
          && JSON.parse(String(callInit.body)).archive === true
      ))
      expect(archiveCall).toBeTruthy()
    })
  })

  it('saves a form as a template', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(false)
      if (path.endsWith('/forms/form-1/save-as-template') && init?.method === 'POST') {
        return jsonResponse({ id: 'template-2', name: 'Saved template', kind: 'extraction', isTemplate: true, activeVersionId: 'v1' }, 201)
      }
      if (path.endsWith('/forms/form-1/fields')) return jsonResponse([])
      return jsonResponse([{ id: 'form-1', name: 'Extraction form', kind: 'extraction', activeVersionId: 'v1' }])
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    const extractionSection = (await screen.findByRole('heading', { name: /Extraction Form/ })).closest('.form-kind-section') as HTMLElement
    fireEvent.click(within(extractionSection).getByRole('button', { name: 'Save as Template' }))

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(([callInput, callInit]) => (
        String(callInput).endsWith('/forms/form-1/save-as-template') && callInit?.method === 'POST'
      ))
      expect(saveCall).toBeTruthy()
    })
    await within(extractionSection).findByText('Template saved.')
  })

  it('lets an administrator inspect, rename, and remove a template inline in Manage Templates', async () => {
    let templates = [{ id: 'template-1', name: 'General extraction', kind: 'extraction', isTemplate: true, activeVersionId: 'v1' }]
    const fields = [{ id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'long_text', required: true, position: 0, isArchived: false, options: [], scoring: {} }]
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/auth/session')) {
        return jsonResponse({ user: { id: 'admin', isAdmin: true }, csrfToken: 'csrf' })
      }
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(false)
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

    const inspectButton = await screen.findByRole('button', { name: 'Inspect & Edit' })
    expect(inspectButton.closest('[data-template-actions]')).toContainElement(
      screen.getByRole('button', { name: 'Remove' }),
    )
    fireEvent.click(inspectButton)
    expect(screen.getByText('Reusable template')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Reusable template' })).not.toBeInTheDocument()
    expect(await screen.findByText('Main finding', { selector: 'strong' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Evidence extraction' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Name' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Evidence extraction' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Template' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Evidence extraction' })).not.toBeInTheDocument())
    expect(fetchMock.mock.calls.some(([callInput, callInit]) => (
      String(callInput).endsWith('/forms/template-1') && callInit?.method === 'DELETE'
    ))).toBe(true)
  })

  it('lets a non-admin inspect but not edit or remove a template', async () => {
    const templates = [{ id: 'template-1', name: 'General extraction', kind: 'extraction', isTemplate: true, activeVersionId: 'v1' }]
    const fields = [{ id: 'field-1', stableKey: 'stable-1', label: 'Main finding', fieldType: 'long_text', required: true, position: 0, isArchived: false, options: [], scoring: {} }]
    mockFetch(async (input) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', canManage: true })
      if (path.endsWith('/quality-config')) return qualityConfigResponse(false)
      if (path.endsWith('/form-templates')) return jsonResponse(templates)
      if (path.endsWith('/forms/template-1/fields')) return jsonResponse(fields)
      if (path.endsWith('/projects/p1/forms')) return jsonResponse([])
      return jsonResponse({})
    })
    renderWithProviders(<FormBuilderPage />, { route: '/projects/p1/forms', path: '/projects/:projectId/forms' })

    const inspectButton = await screen.findByRole('button', { name: 'Inspect' })
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    fireEvent.click(inspectButton)
    expect(await screen.findByText('Main finding', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
    expect(screen.getByText(/Templates are read-only/)).toBeInTheDocument()
  })
})
