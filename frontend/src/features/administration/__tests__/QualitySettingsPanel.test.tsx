import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { QualitySettingsPanel } from '../QualitySettingsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('QualitySettingsPanel', () => {
  it('loads and saves quality assessment settings with separated controls', async () => {
    let config = { enabled: false, mode: 'both', aggregation: 'sum' }
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
    expect(enabledCheckbox.closest('.quality-settings-fields')).toBeInTheDocument()
    expect(screen.getByLabelText('Mode').closest('.quality-settings-selects')).toBeInTheDocument()

    fireEvent.click(enabledCheckbox)
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'numeric' } })
    fireEvent.change(screen.getByLabelText('Aggregation'), { target: { value: 'weighted_average' } })

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(([input, init]) => (
        String(input).endsWith('/quality-config') && init?.method === 'PUT'
      ))
      expect(putCalls.length).toBe(3)
      expect(JSON.parse(String(putCalls[putCalls.length - 1]?.[1]?.body))).toEqual({
        enabled: true,
        mode: 'numeric',
        aggregation: 'weighted_average',
      })
    })
    await screen.findByText('Saved.')
  })
})
