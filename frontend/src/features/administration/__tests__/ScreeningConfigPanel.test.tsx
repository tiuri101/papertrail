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
    expect(titleAbstractLegend.tagName).toBe('LEGEND')
    const titleAbstractForm = titleAbstractLegend.closest('form') as HTMLElement
    expect(within(titleAbstractForm).getByLabelText('Reviewers required per publication')).toHaveValue(1)

    const fullTextLegend = screen.getByText('Full-Text Screening')
    expect(fullTextLegend.tagName).toBe('LEGEND')
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
  // Consumer update for Group B: once a stage has work items the backend
  // refuses structural changes with a 409 naming the setting, so the control
  // freezes rather than inviting the same rejection again.
  it('freezes the locked setting for the stage the backend rejected, and only that stage', async () => {
    mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/screening-config/title_abstract') && init?.method === 'PUT') {
        return jsonResponse(
          {
            error: {
              code: 'structural_setting_locked',
              message: 'Cannot change the required reviewer count for title_abstract screening after work items exist for this stage',
              details: { setting: 'requiredReviewers', stage: 'title_abstract' },
            },
          },
          409,
        )
      }
      return jsonResponse({ id: 'project-1', screeningConfigs: baseConfigs })
    })
    renderWithProviders(<ScreeningConfigPanel projectId="project-1" />)

    const titleAbstractForm = (await screen.findByText('Title/Abstract Screening')).closest('form') as HTMLElement
    fireEvent.change(within(titleAbstractForm).getByLabelText('Reviewers required per publication'), {
      target: { value: '3' },
    })
    fireEvent.click(within(titleAbstractForm).getByRole('button', { name: /Save Title\/Abstract Screening Settings/ }))

    expect(await within(titleAbstractForm).findByText(/Cannot be changed after work has started/)).toBeInTheDocument()
    await waitFor(() => {
      expect(within(titleAbstractForm).getByLabelText('Reviewers required per publication')).toBeDisabled()
    })
    // Allocation is structural too, but this rejection named only the
    // reviewer count -- do not freeze more than the backend refused.
    expect(within(titleAbstractForm).getByLabelText('Allocation')).not.toBeDisabled()

    // A lock is per stage: the other stage's identical control stays editable.
    const fullTextForm = screen.getByText('Full-Text Screening').closest('form') as HTMLElement
    expect(within(fullTextForm).getByLabelText('Reviewers required per publication')).not.toBeDisabled()
  })
})
