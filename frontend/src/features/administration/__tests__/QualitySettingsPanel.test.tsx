import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { QualitySettingsPanel } from '../QualitySettingsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

function putCalls(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => String(input).endsWith('/quality-config') && init?.method === 'PUT',
  )
}

describe('QualitySettingsPanel', () => {
  it('loads and saves quality assessment settings with separated controls', async () => {
    let config = { enabled: false, mode: 'both', aggregation: 'sum', allocationMode: 'claim' }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/quality-config') && init?.method === 'PUT') {
        config = JSON.parse(String(init.body))
        return jsonResponse(config)
      }
      if (path.endsWith('/quality-config')) return jsonResponse(config)
      return jsonResponse({})
    })
    renderWithProviders(<QualitySettingsPanel projectId="p1" />)

    const enabledCheckbox = await screen.findByLabelText('Enable quality assessment')
    expect(enabledCheckbox.closest('[data-quality-settings]')).toBeInTheDocument()
    expect(screen.getByLabelText('Mode').closest('[data-quality-settings-selects]')).toBeInTheDocument()

    fireEvent.click(enabledCheckbox)
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'numeric' } })
    fireEvent.change(screen.getByLabelText('Aggregation'), { target: { value: 'weighted_average' } })

    // Three edits, one request carrying all of them -- not three racing PUTs.
    expect(putCalls(fetchMock)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      expect(putCalls(fetchMock)).toHaveLength(1)
      expect(JSON.parse(String(putCalls(fetchMock)[0]?.[1]?.body))).toEqual({
        enabled: true,
        mode: 'numeric',
        aggregation: 'weighted_average',
        allocationMode: 'claim',
      })
    })
    await screen.findByText('Saved.')
  })

  it('discards local edits and returns to the saved configuration', async () => {
    const config = { enabled: false, mode: 'both', aggregation: 'sum', allocationMode: 'claim' }
    const fetchMock = mockFetch(async () => jsonResponse(config))
    renderWithProviders(<QualitySettingsPanel projectId="p1" />)

    await screen.findByLabelText('Mode')
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'numeric' } })
    expect(await screen.findByText('Unsaved changes.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(screen.getByLabelText('Mode')).toHaveValue('both'))
    expect(putCalls(fetchMock)).toHaveLength(0)
  })

  // Consumer update for Group D: quality scoring settings freeze once
  // responses exist, and allocation once work items exist.
  it('freezes only the setting the backend reports as locked', async () => {
    const config = { enabled: true, mode: 'both', aggregation: 'sum', allocationMode: 'claim' }
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/quality-config') && init?.method === 'PUT') {
        return jsonResponse(
          {
            error: {
              code: 'structural_setting_locked',
              message: 'Cannot change the score aggregation after quality assessments have been submitted for this project',
              details: { setting: 'aggregation', stage: 'quality' },
            },
          },
          409,
        )
      }
      return jsonResponse(config)
    })
    renderWithProviders(<QualitySettingsPanel projectId="p1" />)

    await screen.findByLabelText('Aggregation')
    fireEvent.change(screen.getByLabelText('Aggregation'), { target: { value: 'average' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(await screen.findByText(/Cannot be changed after work has started/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Aggregation')).toBeDisabled())
    expect(screen.getByLabelText('Aggregation')).toHaveValue('sum')
    expect(screen.getByLabelText('Mode')).not.toBeDisabled()
    expect(screen.getByLabelText('Allocation')).not.toBeDisabled()
    // `enabled` is never structural.
    expect(screen.getByLabelText('Enable quality assessment')).not.toBeDisabled()
  })

  // Regression: the panel seeded itself once per mount, so switching the
  // project it points at left the previous project's settings on screen.
  it('reinitializes from the new project when projectId changes without unmounting', async () => {
    const configs: Record<string, Record<string, unknown>> = {
      p1: { enabled: false, mode: 'both', aggregation: 'sum', allocationMode: 'claim' },
      p2: { enabled: true, mode: 'numeric', aggregation: 'average', allocationMode: 'pre_assigned' },
    }
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      const projectId = path.match(/\/projects\/([^/]+)\//)?.[1] ?? ''
      if (path.endsWith('/quality-config') && init?.method === 'PUT') {
        configs[projectId] = JSON.parse(String(init.body))
        return jsonResponse(configs[projectId])
      }
      return jsonResponse(configs[projectId])
    })
    const { rerender } = renderWithProviders(<QualitySettingsPanel projectId="p1" />)

    await screen.findByLabelText('Mode')
    expect(screen.getByLabelText('Mode')).toHaveValue('both')
    expect(screen.getByLabelText('Enable quality assessment')).not.toBeChecked()

    rerender(<QualitySettingsPanel projectId="p2" />)

    await waitFor(() => expect(screen.getByLabelText('Mode')).toHaveValue('numeric'))
    expect(screen.getByLabelText('Aggregation')).toHaveValue('average')
    expect(screen.getByLabelText('Allocation')).toHaveValue('pre_assigned')
    expect(screen.getByLabelText('Enable quality assessment')).toBeChecked()
    expect(screen.queryByText('Unsaved changes.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Enable quality assessment'))
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => {
      const call = putCalls(fetchMock)[0]
      expect(String(call?.[0])).toBe('/api/v1/projects/p2/quality-config')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        enabled: false,
        mode: 'numeric',
        aggregation: 'average',
        allocationMode: 'pre_assigned',
      })
    })
  })

  // A lock is per project; navigating to another project must not carry the
  // frozen control over.
  it('clears latched locks when the project changes', async () => {
    const configs: Record<string, Record<string, unknown>> = {
      p1: { enabled: true, mode: 'both', aggregation: 'sum', allocationMode: 'claim' },
      p2: { enabled: true, mode: 'both', aggregation: 'sum', allocationMode: 'claim' },
    }
    mockFetch(async (input, init) => {
      const path = String(input)
      const projectId = path.match(/\/projects\/([^/]+)\//)?.[1] ?? ''
      if (path.endsWith('/quality-config') && init?.method === 'PUT') {
        return jsonResponse(
          {
            error: {
              code: 'structural_setting_locked',
              message: 'Cannot change the allocation mode after quality work items exist for this project',
              details: { setting: 'allocationMode', stage: 'quality' },
            },
          },
          409,
        )
      }
      return jsonResponse(configs[projectId])
    })
    const { rerender } = renderWithProviders(<QualitySettingsPanel projectId="p1" />)

    await screen.findByLabelText('Allocation')
    fireEvent.change(screen.getByLabelText('Allocation'), { target: { value: 'pre_assigned' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(screen.getByLabelText('Allocation')).toBeDisabled())

    rerender(<QualitySettingsPanel projectId="p2" />)

    await waitFor(() => expect(screen.getByLabelText('Allocation')).not.toBeDisabled())
    expect(screen.queryByText(/Cannot be changed after work has started/)).not.toBeInTheDocument()
  })
})
