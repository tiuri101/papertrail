import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectLifecyclePanel } from '../ProjectLifecyclePanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectLifecyclePanel', () => {
  it('shows integrity issues and reopens at the selected stage', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/reopen') && init?.method === 'POST') return jsonResponse({ stage: 'duplicate_review' })
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [{ code: 'unresolved_duplicates', message: 'Two duplicate candidates remain.' }] })
      return jsonResponse({ stage: 'completed' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)

    expect(await screen.findByText('Two duplicate candidates remain.')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Reopen completed project at'), { target: { value: 'duplicate_review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen project' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(call?.[0]).toBe('/api/v1/projects/p1/reopen')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ targetStage: 'duplicate_review' })
    expect(screen.queryByRole('button', { name: 'Mark project ready' })).not.toBeInTheDocument()
  })

  it('reports a clean project', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [] })
      return jsonResponse({ stage: 'title_abstract_screening' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)
    expect(await screen.findByText('No consistency issues detected.')).toBeInTheDocument()
  })

  it('offers to mark a draft project ready and queues duplicate detection', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (String(input).endsWith('/ready') && init?.method === 'POST') return jsonResponse({ jobId: 'job-1', stage: 'duplicate_review' }, 202)
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [] })
      return jsonResponse({ stage: 'draft' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)

    const button = await screen.findByRole('button', { name: 'Mark project ready' })
    fireEvent.click(button)

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/ready') && init?.method === 'POST')
      expect(call).toBeTruthy()
      expect(call?.[0]).toBe('/api/v1/projects/p1/ready')
    })
  })

  it('shows an error if marking ready fails', async () => {
    mockFetch((input, init) => {
      if (String(input).endsWith('/ready') && init?.method === 'POST') {
        return jsonResponse({ error: { message: 'Only draft projects can be marked ready for duplicate review' } }, 400)
      }
      if (String(input).endsWith('/integrity')) return jsonResponse({ issues: [] })
      return jsonResponse({ stage: 'draft' })
    })
    renderWithProviders(<ProjectLifecyclePanel projectId="p1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Mark project ready' }))
    await waitFor(() => expect(screen.getByText('Only draft projects can be marked ready for duplicate review')).toBeInTheDocument())
  })
})
