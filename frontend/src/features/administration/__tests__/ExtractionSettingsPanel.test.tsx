import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ExtractionSettingsPanel } from '../ExtractionSettingsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function putCalls(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => String(input).endsWith('/extraction-config') && init?.method === 'PUT',
  )
}

describe('ExtractionSettingsPanel', () => {
  it('loads current settings and saves an updated extractors-per-publication value', async () => {
    let config = { allocationMode: 'claim', requiredReviewers: 1 }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/extraction-config') && init?.method === 'PUT') {
        config = JSON.parse(String(init.body))
        return jsonResponse(config)
      }
      return jsonResponse(config)
    })
    renderWithProviders(<ExtractionSettingsPanel projectId="project-1" />)

    await screen.findByText('Extractors per publication')
    expect(screen.getByLabelText('Extractors per publication')).toHaveValue('1')
    expect(screen.getByText(/One reviewer extracts each included publication/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Extractors per publication'), { target: { value: '2' } })
    // Structural settings save explicitly: editing alone must not send anything.
    expect(putCalls(fetchMock)).toHaveLength(0)
    expect(await screen.findByText('Unsaved changes.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(JSON.parse(String(putCalls(fetchMock)[0]?.[1]?.body))).toEqual({
        allocationMode: 'claim',
        requiredReviewers: 2,
      })
    })
    await screen.findByText('Saved.')
    await screen.findByText(/Two different reviewers independently extract/)
  })

  it('shows the backend error and reverts the control when the change is rejected', async () => {
    const config = { allocationMode: 'claim', requiredReviewers: 1 }
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/extraction-config') && init?.method === 'PUT') {
        return jsonResponse(
          { error: { code: 'domain_error', message: 'Extractors per publication must be between 1 and 2' } },
          400,
        )
      }
      return jsonResponse(config)
    })
    renderWithProviders(<ExtractionSettingsPanel projectId="project-1" />)

    await screen.findByText('Extractors per publication')
    fireEvent.change(screen.getByLabelText('Extractors per publication'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await screen.findByText(/Extractors per publication must be between 1 and 2/)
    // A plain rejection leaves the reviewer's edit in place to correct; only
    // a structural lock reverts it (covered below).
    expect(screen.getByLabelText('Extractors per publication')).toHaveValue('2')
  })

  // Consumer update for Group B: the backend now freezes structural settings
  // once work items exist, with a 409 naming the setting.
  it('freezes the named control and restores the saved value after a structural lock', async () => {
    const config = { allocationMode: 'claim', requiredReviewers: 1 }
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/extraction-config') && init?.method === 'PUT') {
        return jsonResponse(
          {
            error: {
              code: 'structural_setting_locked',
              message: 'Cannot change extractors per publication after extraction work items exist for this project',
              details: { setting: 'requiredReviewers', stage: 'extraction' },
            },
          },
          409,
        )
      }
      return jsonResponse(config)
    })
    renderWithProviders(<ExtractionSettingsPanel projectId="project-1" />)

    await screen.findByText('Extractors per publication')
    fireEvent.change(screen.getByLabelText('Extractors per publication'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(await screen.findByText(/Cannot be changed after work has started/)).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByLabelText('Extractors per publication')).toBeDisabled()
    })
    // The rejected value must not linger where the server holds another.
    expect(screen.getByLabelText('Extractors per publication')).toHaveValue('1')
    // The other structural control is untouched by a lock on this one.
    expect(screen.getByLabelText('Allocation')).not.toBeDisabled()
  })

  // Regression: local state used to be seeded once per component instance via
  // a ref that survived a projectId change, so navigating between two
  // projects' settings without unmounting showed -- and would have saved --
  // the first project's configuration.
  it('reinitializes from the new project when projectId changes without unmounting', async () => {
    const configs: Record<string, { allocationMode: string; requiredReviewers: number }> = {
      'project-1': { allocationMode: 'claim', requiredReviewers: 1 },
      'project-2': { allocationMode: 'pre_assigned', requiredReviewers: 2 },
    }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      const projectId = path.match(/\/projects\/([^/]+)\//)?.[1] ?? ''
      if (path.endsWith('/extraction-config') && init?.method === 'PUT') {
        configs[projectId] = JSON.parse(String(init.body))
        return jsonResponse(configs[projectId])
      }
      return jsonResponse(configs[projectId])
    })
    const { rerender } = renderWithProviders(<ExtractionSettingsPanel projectId="project-1" />)

    await screen.findByText('Extractors per publication')
    expect(screen.getByLabelText('Extractors per publication')).toHaveValue('1')
    expect(screen.getByLabelText('Allocation')).toHaveValue('claim')

    rerender(<ExtractionSettingsPanel projectId="project-2" />)

    await waitFor(() => {
      expect(screen.getByLabelText('Extractors per publication')).toHaveValue('2')
    })
    expect(screen.getByLabelText('Allocation')).toHaveValue('pre_assigned')
    expect(screen.queryByText('Unsaved changes.')).not.toBeInTheDocument()

    // Saving now must carry project 2's values to project 2's endpoint.
    fireEvent.change(screen.getByLabelText('Allocation'), { target: { value: 'claim' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      const call = putCalls(fetchMock)[0]
      expect(String(call?.[0])).toBe('/api/v1/projects/project-2/extraction-config')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        allocationMode: 'claim',
        requiredReviewers: 2,
      })
    })
  })

  // Regression: each control used to autosave independently, so several rapid
  // edits raced as separate unordered requests and an older one could land
  // last. One explicit save carries the reviewer's final intent.
  it('sends the last intent as a single request after rapid changes', async () => {
    let config = { allocationMode: 'claim', requiredReviewers: 1 }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/extraction-config') && init?.method === 'PUT') {
        config = JSON.parse(String(init.body))
        return jsonResponse(config)
      }
      return jsonResponse(config)
    })
    renderWithProviders(<ExtractionSettingsPanel projectId="project-1" />)

    await screen.findByText('Extractors per publication')
    fireEvent.change(screen.getByLabelText('Extractors per publication'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Allocation'), { target: { value: 'pre_assigned' } })
    fireEvent.change(screen.getByLabelText('Extractors per publication'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await screen.findByText('Saved.')
    expect(putCalls(fetchMock)).toHaveLength(1)
    expect(JSON.parse(String(putCalls(fetchMock)[0]?.[1]?.body))).toEqual({
      allocationMode: 'pre_assigned',
      requiredReviewers: 1,
    })
    expect(screen.getByLabelText('Extractors per publication')).toHaveValue('1')
    expect(screen.getByLabelText('Allocation')).toHaveValue('pre_assigned')
  })
})
