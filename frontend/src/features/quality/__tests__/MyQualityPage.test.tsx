import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MyQualityPage } from '../MyQualityPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const baseEntry = {
  id: 'quality-1',
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
  version: 1,
  totalScore: 8,
}

function renderMyQuality(handler: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(handler)
  renderWithProviders(<MyQualityPage />, {
    route: '/projects/p1/quality/mine',
    path: '/projects/:projectId/quality/mine',
  })
  return fetchMock
}

describe('MyQualityPage', () => {
  it('lists the reviewer completed assessments', async () => {
    renderMyQuality(async (input) => (
      String(input).endsWith('/quality/mine') ? jsonResponse([baseEntry]) : jsonResponse({})
    ))

    expect(await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })).toBeInTheDocument()
    expect(screen.getByText(/Total score 8/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Immersive Urban Analytics' })).toHaveAttribute(
      'href',
      '/projects/p1/publications/publication-1',
    )
    expect(document.querySelector('time')).toHaveAttribute('datetime', baseEntry.completedAt)
    expect(screen.getByRole('button', { name: 'Edit Assessment' })).toBeInTheDocument()
  })

  it('reports when nothing has been submitted yet', async () => {
    renderMyQuality(async () => jsonResponse([]))

    expect(await screen.findByText('You have not submitted any quality assessments yet.')).toBeInTheDocument()
  })

  it('searches and sorts submitted assessments', async () => {
    const second = {
      ...baseEntry,
      id: 'quality-2',
      publicationId: 'publication-2',
      publication: { ...baseEntry.publication, id: 'publication-2', title: 'Alpha Study', authors: 'Z. Reviewer' },
      completedAt: '2026-03-01T00:00:00Z',
    }
    renderMyQuality(async (input) => (
      String(input).endsWith('/quality/mine') ? jsonResponse([baseEntry, second]) : jsonResponse({})
    ))

    await screen.findByRole('heading', { name: 'Alpha Study' })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Alpha Study',
      'Immersive Urban Analytics',
    ])

    expect(document.querySelector('.publication-list__header')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'title:desc' } })
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Immersive Urban Analytics',
      'Alpha Study',
    ])

    fireEvent.change(screen.getByLabelText('Search papers'), { target: { value: 'Z. Reviewer' } })
    expect(screen.getByRole('heading', { name: 'Alpha Study' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Immersive Urban Analytics' })).not.toBeInTheDocument()
    expect(screen.getByText('1 of 2 assessments match your filters')).toBeInTheDocument()
  })

  it('edits and resubmits a past assessment inline, then refreshes the list', async () => {
    let listCallCount = 0
    const fetchMock = renderMyQuality(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/quality/mine')) {
        listCallCount += 1
        return jsonResponse([{ ...baseEntry, version: listCallCount > 1 ? 2 : 1, totalScore: listCallCount > 1 ? 5 : 8 }])
      }
      if (path.endsWith('/quality/quality-1') && !init?.method) {
        return jsonResponse({
          id: 'quality-1',
          publicationId: 'publication-1',
          status: 'completed',
          draft: { design: 'Strong' },
          publication: baseEntry.publication,
          fields: [
            { id: 'field-1', stableKey: 'design', label: 'Study design', fieldType: 'single_select', required: true, options: ['Strong', 'Weak'] },
          ],
          currentResponse: { id: 'response-1', answers: { design: 'Strong' }, totalScore: 8, version: 1 },
        })
      }
      if (path.endsWith('/quality/quality-1') && init?.method === 'POST') {
        return jsonResponse({ id: 'response-2', answers: {}, totalScore: 5, version: 2 }, 201)
      }
      return jsonResponse({})
    })

    await screen.findByRole('heading', { name: 'Immersive Urban Analytics' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit Assessment' }))

    expect(await screen.findByLabelText('Study design *')).toHaveValue('Strong')
    fireEvent.change(screen.getByLabelText('Study design *'), { target: { value: 'Weak' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save corrected assessment' }))

    await waitFor(() => {
      const submitCall = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/quality/quality-1') && init?.method === 'POST',
      )
      expect(submitCall).toBeTruthy()
      expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({
        answers: { design: 'Weak' },
      })
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit Assessment' })).toBeInTheDocument()
    })
    expect(await screen.findByText(/Total score 5/)).toBeInTheDocument()
  })
})
