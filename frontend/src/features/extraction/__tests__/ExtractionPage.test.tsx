import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ExtractionPage } from '../ExtractionPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ExtractionPage', () => {
  it('loads the next assignment, restores its draft, and submits structured answers', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/next')) {
        return jsonResponse({ id: 'extraction-1', publicationId: 'publication-1', draft: { finding: 'Initial note' } })
      }
      if (init?.method === 'POST') return jsonResponse({ id: 'response-1', status: 'completed' }, 201)
      return jsonResponse({})
    })
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    fireEvent.click(screen.getByRole('button', { name: 'Get next extraction' }))
    expect(await screen.findByText('Publication: publication-1')).toBeInTheDocument()
    const textarea = screen.getByLabelText('Structured answers (JSON)')
    expect(textarea).toHaveValue(JSON.stringify({ finding: 'Initial note' }, null, 2))

    fireEvent.change(textarea, { target: { value: '{"finding":"Updated finding","sampleSize":24}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit extraction' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Get next extraction' })).toBeInTheDocument())
    const submitCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/extraction/extraction-1'))
    expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({
      answers: { finding: 'Updated finding', sampleSize: 24 },
    })
  })

  it('reports malformed JSON instead of sending it', async () => {
    const fetchMock = mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ id: 'extraction-1', publicationId: 'publication-1', draft: {} })
      : jsonResponse({}))
    renderWithProviders(<ExtractionPage />, { route: '/projects/p1/extraction', path: '/projects/:projectId/extraction' })

    fireEvent.click(screen.getByRole('button', { name: 'Get next extraction' }))
    await screen.findByText('Publication: publication-1')
    fireEvent.change(screen.getByLabelText('Structured answers (JSON)'), { target: { value: '{invalid' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit extraction' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/JSON/))
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/extraction/extraction-1'))).toHaveLength(0)
  })
})
