import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HighlightKeywordsPanel } from '../HighlightKeywordsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('HighlightKeywordsPanel', () => {
  it('loads existing keywords and saves an edited list', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/highlight-keywords') && init?.method === 'PUT') {
        return jsonResponse({ keywords: ['virtual reality', 'urban analytics', 'new keyword'] })
      }
      return jsonResponse({ keywords: ['virtual reality', 'urban analytics'] })
    })
    renderWithProviders(<HighlightKeywordsPanel projectId="project-1" />)

    const textarea = await screen.findByLabelText('Keywords')
    await waitFor(() => expect(textarea).toHaveValue('virtual reality\nurban analytics'))

    fireEvent.change(textarea, { target: { value: 'virtual reality\nurban analytics\nnew keyword' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Keywords' }))

    await waitFor(() => expect(screen.getByText('Keywords saved.')).toBeInTheDocument())
    const putCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/highlight-keywords') && init?.method === 'PUT')
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      keywords: ['virtual reality', 'urban analytics', 'new keyword'],
    })
  })
})
