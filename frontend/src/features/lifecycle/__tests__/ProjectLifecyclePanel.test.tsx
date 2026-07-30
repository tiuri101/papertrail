import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectLifecyclePanel } from '../ProjectLifecyclePanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectLifecyclePanel', () => {
  it('shows integrity issues and reopens at the selected stage', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/reopen') && init?.method === 'POST') return jsonResponse({ stage: 'duplicate_review' })
      return jsonResponse({ issues: [{ code: 'unresolved_duplicates', message: 'Two duplicate candidates remain.' }] })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)

    expect(await screen.findByText('Two duplicate candidates remain.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Reopen completed project at'), { target: { value: 'duplicate_review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen project' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(call?.[0]).toBe('/api/v1/projects/p1/reopen')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ targetStage: 'duplicate_review' })
  })

  it('reports a clean project', async () => {
    mockFetch(() => jsonResponse({ issues: [] }))
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)
    expect(await screen.findByText('No consistency issues detected.')).toBeInTheDocument()
  })
})
