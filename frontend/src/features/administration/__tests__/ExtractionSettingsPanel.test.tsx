import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ExtractionSettingsPanel } from '../ExtractionSettingsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

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

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/extraction-config') && init?.method === 'PUT',
      )
      expect(putCall).toBeTruthy()
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        allocationMode: 'claim',
        requiredReviewers: 2,
      })
    })

    await screen.findByText(/Two different reviewers independently extract/)
  })

  it('shows the backend error and reverts the control when the change is rejected', async () => {
    const config = { allocationMode: 'claim', requiredReviewers: 1 }
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/extraction-config') && init?.method === 'PUT') {
        return jsonResponse(
          { error: { code: 'domain_error', message: 'Cannot change extractors per publication after extraction work has begun' } },
          400,
        )
      }
      return jsonResponse(config)
    })
    renderWithProviders(<ExtractionSettingsPanel projectId="project-1" />)

    await screen.findByText('Extractors per publication')
    fireEvent.change(screen.getByLabelText('Extractors per publication'), { target: { value: '2' } })

    await screen.findByText(/Cannot change extractors per publication/)
    await waitFor(() => {
      expect(screen.getByLabelText('Extractors per publication')).toHaveValue('1')
    })
  })
})
