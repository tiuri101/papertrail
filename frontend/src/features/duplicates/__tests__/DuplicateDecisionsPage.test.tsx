import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DuplicateDecisionsPage } from '../DuplicateDecisionsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const base = {
  matchReasons: ['exact_doi'],
  titleSimilarity: 95,
  authorSimilarity: 88,
  yearAgreement: true,
  confidence: 0.98,
  autoResolved: false,
  resolutionNote: null,
  reservedUntil: null,
  reservedById: null,
}

const merged = {
  ...base,
  id: 'm1',
  publicationA: { id: 'pub-a', title: 'Merged A', authors: 'Alice', publicationYear: 2025, venue: 'CHI', doi: '10.1/a' },
  publicationB: { id: 'pub-b', title: 'Merged B', authors: 'Alice', publicationYear: 2025, venue: 'CHI', doi: '10.1/a' },
  status: 'merged',
  resolvedById: 'u-alice',
  resolvedByName: 'Alice',
  resolvedAt: '2026-08-20T10:00:00Z',
  canonicalPublicationId: 'pub-a',
  mergeId: 'mg1',
}

const notDuplicate = {
  ...base,
  id: 'n1',
  publicationA: { id: 'pub-c', title: 'Distinct A', authors: 'Bob', publicationYear: 2024, venue: 'UIST', doi: null },
  publicationB: { id: 'pub-d', title: 'Distinct B', authors: 'Bob', publicationYear: 2024, venue: 'UIST', doi: null },
  status: 'not_duplicate',
  resolvedById: 'u-bob',
  resolvedByName: 'Bob',
  resolvedAt: '2026-08-21T10:00:00Z',
  canonicalPublicationId: null,
  mergeId: null,
}

const unresolved = {
  ...base,
  id: 'u1',
  publicationA: { id: 'pub-e', title: 'Open A', authors: null, publicationYear: null, venue: null, doi: null },
  publicationB: { id: 'pub-f', title: 'Open B', authors: null, publicationYear: null, venue: null, doi: null },
  status: 'unresolved',
  resolvedById: null,
  resolvedByName: null,
  resolvedAt: null,
  canonicalPublicationId: null,
  mergeId: null,
}

function renderPage(stage = 'duplicate_review', onFetch?: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(onFetch ?? (async (input) => {
    const path = String(input)
    if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', stage })
    if (path.endsWith('/projects/p1/duplicates')) {
      return jsonResponse([merged, notDuplicate, unresolved])
    }
    return jsonResponse([])
  }))
  renderWithProviders(<DuplicateDecisionsPage />, {
    route: '/projects/p1/duplicates/decisions',
    path: '/projects/:projectId/duplicates/decisions',
  })
  return fetchMock
}

describe('DuplicateDecisionsPage', () => {
  it('lists every resolved pair from all reviewers and hides unresolved ones', async () => {
    renderPage()

    expect(await screen.findByText('Merged A')).toBeInTheDocument()
    expect(screen.getByText('Distinct A')).toBeInTheDocument()
    expect(screen.queryByText('Open A')).not.toBeInTheDocument()
    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('Merged · kept A')).toBeInTheDocument()
  })

  it('filters by decision', async () => {
    renderPage()
    await screen.findByText('Merged A')

    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'not_duplicate' } })

    expect(screen.getByText('Distinct A')).toBeInTheDocument()
    expect(screen.queryByText('Merged A')).not.toBeInTheDocument()
  })

  it('changes a decision through the revise endpoint', async () => {
    const fetchMock = renderPage('duplicate_review', async (input, init) => {
      const path = String(input)
      if (path.endsWith('/projects/p1')) return jsonResponse({ id: 'p1', stage: 'duplicate_review' })
      if (path.endsWith('/projects/p1/duplicates') && init?.method !== 'POST') {
        return jsonResponse([merged, notDuplicate])
      }
      if (path.endsWith('/duplicates/m1/revise') && init?.method === 'POST') {
        return jsonResponse({ ...merged, status: 'not_duplicate', canonicalPublicationId: null })
      }
      return jsonResponse([])
    })

    const row = (await screen.findByText('Merged A')).closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Change' }))
    fireEvent.click(within(row).getByRole('button', { name: 'Not a Duplicate' }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([i, init]) => (
      String(i).endsWith('/duplicates/m1/revise') && init?.method === 'POST'
    ))).toBe(true))
    const call = fetchMock.mock.calls.find(([i]) => String(i).endsWith('/duplicates/m1/revise'))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ resolution: 'not_duplicate' })
  })

  it('is read-only once the project has left duplicate review', async () => {
    renderPage('title_abstract_screening')

    expect(
      await screen.findByText('Duplicate review is complete for this project'),
    ).toBeInTheDocument()
    const row = (await screen.findByText('Merged A')).closest('li') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'View' }))
    expect(within(row).queryByRole('button', { name: 'Not a Duplicate' })).not.toBeInTheDocument()
  })
})
