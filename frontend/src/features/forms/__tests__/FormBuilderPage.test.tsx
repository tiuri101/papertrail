import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
    fireEvent.click(screen.getByRole('button', { name: 'Create form' }))

    await waitFor(() => expect(screen.getByLabelText('Active form')).toHaveValue('form-1'))
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Main finding' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'long_text' } })
    fireEvent.click(screen.getByLabelText('Required'))
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))

    expect(await screen.findByText('Main finding — long_text — required')).toBeInTheDocument()
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
    fireEvent.change(screen.getByLabelText('Active form'), { target: { value: 'form-1' } })
    fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'Study design' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'single_select' } })
    fireEvent.change(screen.getByLabelText('Options (one per line)'), { target: { value: 'Experimental\nObservational' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))

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
    fireEvent.change(screen.getByLabelText('Active form'), { target: { value: 'form-1' } })
    fireEvent.change(await screen.findByLabelText('Label'), { target: { value: 'Study design' } })
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'single_select' } })
    fireEvent.change(screen.getByLabelText('Options (one per line)'), { target: { value: 'Strong\nWeak' } })
    fireEvent.change(screen.getByLabelText('Strong'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Weak'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Save quality settings' }))

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/quality-config') && init?.method === 'PUT')
      expect(putCall).toBeTruthy()
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({ enabled: true, mode: 'numeric', aggregation: 'weighted_average' })
    })
  })
})
