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
})
