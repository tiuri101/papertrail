import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScreeningConfigPanel } from '../ScreeningConfigPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const baseConfigs = [
  {
    id: 'config-1',
    stage: 'title_abstract',
    requiredReviewers: 1,
    allocationMode: 'divided',
    conflictResolution: 'admin_consensus',
    uncertainResolution: 'admin_consensus',
  },
  {
    id: 'config-2',
    stage: 'full_text',
    requiredReviewers: 2,
    allocationMode: 'independent',
    conflictResolution: 'majority',
    uncertainResolution: 'admin_consensus',
  },
]

describe('ScreeningConfigPanel', () => {
  it('loads current per-stage settings and saves an updated reviewer count', async () => {
    let configs = baseConfigs
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/screening-config/title_abstract') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        configs = configs.map((config) => (
          config.stage === 'title_abstract' ? { ...config, ...body } : config
        ))
        return jsonResponse({ ...configs[0] })
      }
      return jsonResponse({ id: 'project-1', screeningConfigs: configs })
    })
    renderWithProviders(<ScreeningConfigPanel projectId="project-1" />)

    const titleAbstractLegend = await screen.findByText('Title/Abstract Screening')
    expect(titleAbstractLegend).toHaveClass('subsection-heading')
    const titleAbstractForm = titleAbstractLegend.closest('form') as HTMLElement
    expect(within(titleAbstractForm).getByLabelText('Reviewers required per publication')).toHaveValue(1)

    const fullTextLegend = screen.getByText('Full-Text Screening')
    expect(fullTextLegend).toHaveClass('subsection-heading')
    const fullTextForm = fullTextLegend.closest('form') as HTMLElement
    expect(within(fullTextForm).getByLabelText('Reviewers required per publication')).toHaveValue(2)

    fireEvent.change(within(titleAbstractForm).getByLabelText('Reviewers required per publication'), { target: { value: '3' } })
    fireEvent.change(within(titleAbstractForm).getByLabelText('When reviewers disagree'), { target: { value: 'majority' } })
    fireEvent.click(within(titleAbstractForm).getByRole('button', { name: 'Save Title/Abstract Screening Settings' }))

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/screening-config/title_abstract') && init?.method === 'PUT',
      )
      expect(putCall).toBeTruthy()
      expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
        requiredReviewers: 3,
        allocationMode: 'divided',
        conflictResolution: 'majority',
        uncertainResolution: 'admin_consensus',
      })
    })

    await waitFor(() => {
      const refreshedForm = screen.getByText('Title/Abstract Screening').closest('form') as HTMLElement
      expect(within(refreshedForm).getByLabelText('Reviewers required per publication')).toHaveValue(3)
    })
  })
})
