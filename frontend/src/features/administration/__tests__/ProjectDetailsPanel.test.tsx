import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectDetailsPanel } from '../ProjectDetailsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const projectDetail = {
  id: 'p1',
  name: 'Urban VR Review',
  description: 'Original description',
}

describe('ProjectDetailsPanel', () => {
  it('loads the current name and description', async () => {
    mockFetch(() => jsonResponse(projectDetail))
    renderWithProviders(<ProjectDetailsPanel projectId="p1" />)

    expect(await screen.findByDisplayValue('Urban VR Review')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Original description')).toBeInTheDocument()
  })

  it('saves a renamed project', async () => {
    const fetchMock = mockFetch((_input, init) => {
      if (init?.method === 'PATCH') {
        return jsonResponse({ ...projectDetail, name: 'Renamed Review' })
      }
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ProjectDetailsPanel projectId="p1" />)

    const input = await screen.findByDisplayValue('Urban VR Review')
    fireEvent.change(input, { target: { value: 'Renamed Review' } })
    fireEvent.blur(input)

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        name: 'Renamed Review',
        description: 'Original description',
      })
    })
    expect(await screen.findByText('Saved.')).toBeInTheDocument()
  })
})
