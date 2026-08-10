import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MyExtractionsPage } from '../MyExtractionsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const baseEntry = {
  id: 'extraction-1',
  publicationId: 'publication-1',
  publication: {
    id: 'publication-1',
    title: 'Immersive Urban Analytics',
    authors: 'A. Author',
    abstract: 'A study of urban data in virtual reality.',
    publicationYear: 2024,
    venue: null,
    doi: '10.1000/example',
    publisherUrl: null,
  },
  completedAt: '2026-01-01T00:00:00Z',
  version: 2,
}

function renderMyExtractions(handler: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(handler)
  renderWithProviders(<MyExtractionsPage />, {
    route: '/projects/p1/extraction/mine',
    path: '/projects/:projectId/extraction/mine',
  })
  return fetchMock
}

describe('MyExtractionsPage', () => {
  it('lists the reviewer completed extractions', async () => {
    renderMyExtractions(async (input) => (
      String(input).endsWith('/extraction/mine') ? jsonResponse([baseEntry]) : jsonResponse({})
    ))

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByText('v2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Extraction' })).toBeInTheDocument()
  })

  it('reports when nothing has been submitted yet', async () => {
    renderMyExtractions(async () => jsonResponse([]))

    expect(await screen.findByText('You have not submitted any extractions yet.')).toBeInTheDocument()
  })

  it('searches and sorts submitted extractions', async () => {
    const second = {
      ...baseEntry,
      id: 'extraction-2',
      publicationId: 'publication-2',
      publication: { ...baseEntry.publication, id: 'publication-2', title: 'Alpha Study', authors: 'Z. Reviewer' },
      completedAt: '2026-03-01T00:00:00Z',
    }
    renderMyExtractions(async (input) => (
      String(input).endsWith('/extraction/mine') ? jsonResponse([baseEntry, second]) : jsonResponse({})
    ))

    await screen.findByRole('heading', { name: 'Alpha Study' })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Alpha Study',
      'Immersive Urban Analytics',
    ])

    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'title_asc' } })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Alpha Study',
      'Immersive Urban Analytics',
    ])

    fireEvent.change(screen.getByLabelText('Search papers'), { target: { value: 'Z. Reviewer' } })
    expect(screen.getByRole('heading', { name: 'Alpha Study' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Immersive Urban Analytics' })).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 extractions match your filters')).toBeInTheDocument()
  })

  it('edits and resubmits a past extraction inline, then refreshes the list', async () => {
    let listCallCount = 0
    const fetchMock = renderMyExtractions(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/extraction/mine')) {
        listCallCount += 1
        return jsonResponse([{ ...baseEntry, version: listCallCount > 1 ? 3 : 2 }])
      }
      if (path.endsWith('/extraction/extraction-1') && !init?.method) {
        return jsonResponse({
          id: 'extraction-1',
          publicationId: 'publication-1',
          fullTextAvailable: false,
          status: 'completed',
          draft: { finding: 'Human finding' },
          publication: baseEntry.publication,
          fields: [
            { id: 'field-1', stableKey: 'finding', label: 'Main finding', fieldType: 'long_text', required: true, options: [] },
          ],
          currentResponse: { id: 'response-1', answers: { finding: 'Human finding' }, version: 2, formVersionId: 'v1' },
        })
      }
      if (path.endsWith('/extraction/extraction-1') && init?.method === 'POST') {
        return jsonResponse({ id: 'response-2', answers: {}, version: 3, formVersionId: 'v1' }, 201)
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Extraction' }))

    expect(await screen.findByLabelText('Main finding *')).toHaveValue('Human finding')
    fireEvent.change(screen.getByLabelText('Main finding *'), { target: { value: 'Corrected finding' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save corrected extraction' }))

    await waitFor(() => {
      const submitCall = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/extraction/extraction-1') && init?.method === 'POST',
      )
      expect(submitCall).toBeTruthy()
      expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({
        answers: { finding: 'Corrected finding' },
        suggestionActions: { finding: 'manual' },
      })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit Extraction' })).toBeInTheDocument()
    })
    expect(await screen.findByText('v3')).toBeInTheDocument()
  })
})
