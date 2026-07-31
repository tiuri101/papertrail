import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ScreeningAssignmentsPanel } from '../ScreeningAssignmentsPanel'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const projectDetail = {
  id: 'p1',
  memberships: [
    {
      id: 'm1',
      userId: 'u1',
      canTitleAbstractScreen: true,
      canFullTextScreen: false,
      canExtract: false,
      canAssessQuality: false,
      canAdjudicate: false,
    },
    {
      id: 'm2',
      userId: 'u2',
      canTitleAbstractScreen: true,
      canFullTextScreen: false,
      canExtract: false,
      canAssessQuality: false,
      canAdjudicate: false,
    },
  ],
}

const users = [
  { id: 'u1', username: 'alice', displayName: 'Alice Reviewer', isAdmin: false, isActive: true },
  { id: 'u2', username: 'bob', displayName: 'Bob Reviewer', isAdmin: false, isActive: true },
  { id: 'u3', username: 'outsider', displayName: 'Outsider', isAdmin: false, isActive: true },
]

const assignments = [
  {
    id: 'w1',
    publicationId: 'pub1',
    publicationTitle: 'Immersive Analytics Study',
    slotNumber: 1,
    status: 'available',
    assignedReviewerId: 'u1',
    assignedReviewerName: 'Alice Reviewer',
  },
  {
    id: 'w2',
    publicationId: 'pub2',
    publicationTitle: 'Second Paper',
    slotNumber: 1,
    status: 'submitted',
    assignedReviewerId: 'u2',
    assignedReviewerName: 'Bob Reviewer',
  },
]

function page(items: typeof assignments, overrides: Partial<{ total: number; page: number; pageSize: number }> = {}) {
  return { items, total: items.length, page: 1, pageSize: 20, ...overrides }
}

describe('ScreeningAssignmentsPanel', () => {
  it('lists assignments with their current reviewer and status', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/users')) return jsonResponse(users)
      if (url.includes('/assignments')) return jsonResponse(page(assignments))
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)

    const row = (await screen.findByText('Immersive Analytics Study')).closest('tr') as HTMLElement
    expect(within(row).getByText('Available')).toBeInTheDocument()
    expect(within(row).getByText('Alice Reviewer')).toBeInTheDocument()

    const submittedRow = screen.getByText('Second Paper').closest('tr') as HTMLElement
    expect(within(submittedRow).getByText('Already submitted')).toBeInTheDocument()
    expect(within(submittedRow).queryByRole('button', { name: 'Reassign' })).not.toBeInTheDocument()
  })

  it('only offers project members eligible for the selected stage, excluding the current assignee', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/users')) return jsonResponse(users)
      if (url.includes('/assignments')) return jsonResponse(page(assignments))
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)

    await screen.findByText('Immersive Analytics Study')
    const select = screen.getByLabelText('Reassign Immersive Analytics Study') as HTMLSelectElement
    const optionLabels = Array.from(select.options).map((option) => option.textContent)
    expect(optionLabels).toContain('Bob Reviewer')
    expect(optionLabels).not.toContain('Alice Reviewer')
    expect(optionLabels).not.toContain('Outsider')
  })

  it('reassigns a work item to the selected reviewer', async () => {
    const fetchMock = mockFetch((input, init) => {
      const url = String(input)
      if (init?.method === 'PATCH') return jsonResponse({ ...assignments[0], assignedReviewerId: 'u2' })
      if (url.endsWith('/users')) return jsonResponse(users)
      if (url.includes('/assignments')) return jsonResponse(page(assignments))
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)

    await screen.findByText('Immersive Analytics Study')
    fireEvent.change(screen.getByLabelText('Reassign Immersive Analytics Study'), { target: { value: 'u2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reassign' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/screening/work-items/w1/reassign')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ reviewerId: 'u2' })
    })
  })

  it('switches stages and refetches assignments for that stage', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/users')) return jsonResponse(users)
      if (url.includes('/screening/full_text/assignments')) return jsonResponse(page([]))
      if (url.includes('/assignments')) return jsonResponse(page(assignments))
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)

    await screen.findByText('Immersive Analytics Study')
    fireEvent.change(screen.getByLabelText('Stage'), { target: { value: 'full_text' } })

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/screening/full_text/assignments'))).toBe(true)
    })
    expect(await screen.findByText('No publications match these filters.')).toBeInTheDocument()
  })

  it('toggles sort order when a column header is clicked twice', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/users')) return jsonResponse(users)
      if (url.includes('/assignments')) return jsonResponse(page(assignments))
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)
    await screen.findByText('Immersive Analytics Study')

    const header = screen.getByRole('columnheader', { name: /Publication/ })
    expect(header).toHaveAttribute('aria-sort', 'ascending')

    fireEvent.click(within(header).getByRole('button'))
    await waitFor(() => expect(header).toHaveAttribute('aria-sort', 'descending'))
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('sort=publicationTitle') && String(input).includes('order=desc'))).toBe(true)

    fireEvent.click(within(header).getByRole('button'))
    await waitFor(() => expect(header).toHaveAttribute('aria-sort', 'ascending'))
  })

  it('sorts by a different column when its header is clicked', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/users')) return jsonResponse(users)
      if (url.includes('/assignments')) return jsonResponse(page(assignments))
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)
    await screen.findByText('Immersive Analytics Study')

    fireEvent.click(screen.getByRole('button', { name: 'Status' }))

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('sort=status') && String(input).includes('order=asc'))).toBe(true)
    })
  })

  it('filters by search text after a short debounce', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = mockFetch((input) => {
        const url = String(input)
        if (url.endsWith('/users')) return jsonResponse(users)
        if (url.includes('/assignments')) return jsonResponse(page(assignments))
        return jsonResponse(projectDetail)
      })
      renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)
      await vi.waitFor(() => screen.findByText('Immersive Analytics Study'))

      fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'Immersive' } })
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('search=Immersive'))).toBe(false)

      await act(() => vi.advanceTimersByTimeAsync(300))

      await vi.waitFor(() => {
        expect(fetchMock.mock.calls.some(([input]) => String(input).includes('search=Immersive'))).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('filters by status and by reviewer', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/users')) return jsonResponse(users)
      if (url.includes('/assignments')) return jsonResponse(page(assignments))
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)
    await screen.findByText('Immersive Analytics Study')

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'submitted' } })
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('status=submitted'))).toBe(true)
    })

    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: 'u2' } })
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('reviewerId=u2'))).toBe(true)
    })
  })

  it('paginates with Previous and Next controls', async () => {
    const fetchMock = mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/users')) return jsonResponse(users)
      if (url.includes('/assignments')) return jsonResponse(page(assignments, { total: 45 }))
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<ScreeningAssignmentsPanel projectId="p1" />)
    await screen.findByText('Immersive Analytics Study')

    expect(screen.getByText('Page 1 of 3 (45 total)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('page=2'))).toBe(true)
    })
  })
})
