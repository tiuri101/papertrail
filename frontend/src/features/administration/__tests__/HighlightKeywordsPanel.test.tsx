import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HighlightKeywordsPanel } from '../HighlightKeywordsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('HighlightKeywordsPanel', () => {
  it('previews, adds, edits, deletes, and autosaves keywords', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/highlight-keywords') && init?.method === 'PUT') {
        return jsonResponse({ keywords: ['immersive media', 'new keyword'] })
      }
      return jsonResponse({ keywords: ['virtual reality', 'urban analytics'] })
    })
    renderWithProviders(<HighlightKeywordsPanel projectId="project-1" />)

    const firstKeyword = await screen.findByLabelText('Keyword 1')
    expect(firstKeyword).toHaveValue('virtual reality')
    expect(screen.getByLabelText('Keyword 2')).toHaveValue('urban analytics')
    expect(screen.getByText('virtual reality', { selector: 'mark' })).toHaveClass('mark-kw-3')

    fireEvent.change(firstKeyword, { target: { value: 'immersive media' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete keyword 2' }))
    fireEvent.change(screen.getByLabelText('Add a keyword'), { target: { value: 'new keyword' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add keyword' }))

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

    await waitFor(() => expect(screen.getByText('Saved.')).toBeInTheDocument())
    const putCall = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/highlight-keywords') && init?.method === 'PUT')
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      keywords: ['immersive media', 'new keyword'],
    })
  })
})
