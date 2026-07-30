import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { QualityPage } from '../QualityPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('QualityPage', () => {
  it('loads and submits one quality assessment', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      if (String(input).endsWith('/next')) {
        return jsonResponse({ id: 'quality-1', publicationId: 'publication-1', draft: { reporting: 2 } })
      }
      if (init?.method === 'POST') return jsonResponse({ id: 'response-1', totalScore: 4 }, 201)
      return jsonResponse({})
    })
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    fireEvent.click(screen.getByRole('button', { name: 'Get next assessment' }))
    expect(await screen.findByText('Publication: publication-1')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Structured answers (JSON)'), {
      target: { value: '{"reporting":2,"methodology":2}' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit assessment' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Get next assessment' })).toBeInTheDocument())
    const submitCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/quality/quality-1'))
    expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({ answers: { reporting: 2, methodology: 2 } })
  })

  it('reports malformed JSON without calling the submission endpoint', async () => {
    const fetchMock = mockFetch(async (input) => String(input).endsWith('/next')
      ? jsonResponse({ id: 'quality-1', publicationId: 'publication-1', draft: {} })
      : jsonResponse({}))
    renderWithProviders(<QualityPage />, { route: '/projects/p1/quality', path: '/projects/:projectId/quality' })

    fireEvent.click(screen.getByRole('button', { name: 'Get next assessment' }))
    await screen.findByText('Publication: publication-1')
    fireEvent.change(screen.getByLabelText('Structured answers (JSON)'), { target: { value: 'not-json' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit assessment' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/JSON/))
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/quality/quality-1'))).toHaveLength(0)
  })
})
