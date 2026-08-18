import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ReopenProjectPanel } from '../ReopenProjectPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ReopenProjectPanel', () => {
  it('reopens a completed project at the selected stage', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/reopen') && init?.method === 'POST') return jsonResponse({ stage: 'duplicate_review' })
      return jsonResponse({ stage: 'completed' })
    })
    renderWithProviders(<ReopenProjectPanel projectId="p1" />)

    expect(await screen.findByRole('heading', { name: 'Reopen at an Earlier Stage' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Duplicate Review' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Reopen at'), { target: { value: 'duplicate_review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen Project' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(call?.[0]).toBe('/api/v1/projects/p1/reopen')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ targetStage: 'duplicate_review' })
  })

  it('renders nothing when the project has not reached Completed', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ stage: 'title_abstract_screening' }))
    renderWithProviders(<ReopenProjectPanel projectId="p1" />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByRole('heading', { name: 'Reopen at an Earlier Stage' })).not.toBeInTheDocument()
  })
})
