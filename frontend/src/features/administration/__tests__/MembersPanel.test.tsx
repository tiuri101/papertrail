import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MembersPanel } from '../MembersPanel'
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
      workloadWeight: 1,
    },
  ],
}

const users = [
  { id: 'u1', username: 'alice', displayName: 'Alice Reviewer', isActive: true },
  { id: 'u2', username: 'bob', displayName: 'Bob Reviewer', isActive: true },
]

describe('MembersPanel', () => {
  it('lists existing members with their roles', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    const row = (await screen.findByText('Alice Reviewer (alice)')).closest('tr') as HTMLElement
    expect(within(row).getByText('Title/abstract screening')).toBeInTheDocument()
  })

  it('only offers non-member users when adding a new member', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    await screen.findByText('Alice Reviewer (alice)')
    const select = screen.getByLabelText('Reviewer') as HTMLSelectElement
    const optionValues = Array.from(select.options).map((option) => option.value)
    expect(optionValues).not.toContain('u1')
    expect(optionValues).toContain('u2')
  })

  it('hides the stage checkboxes until a reviewer is selected', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    await screen.findByText('Alice Reviewer (alice)')
    const form = screen.getByRole('button', { name: 'Add Member' }).closest('form') as HTMLElement
    expect(within(form).queryByText('Stages')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: 'u2' } })

    expect(within(form).getByText('Stages')).toBeInTheDocument()
  })

  it('edits an existing member\'s stage assignments', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'PATCH') {
        return jsonResponse({
          id: 'm1',
          userId: 'u1',
          canTitleAbstractScreen: true,
          canFullTextScreen: true,
          canExtract: false,
          canAssessQuality: false,
          canAdjudicate: false,
          workloadWeight: 1,
        })
      }
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    const row = (await screen.findByText('Alice Reviewer (alice)')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }))
    fireEvent.click(within(row).getByLabelText('Full-text screening'))
    fireEvent.click(within(row).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/members/m1')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        canTitleAbstractScreen: true,
        canFullTextScreen: true,
        canExtract: false,
        canAssessQuality: false,
        canAdjudicate: false,
        workloadWeight: 1,
      })
    })
  })

  it('removes a member after confirmation', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'DELETE') return jsonResponse(null, 204)
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    const row = (await screen.findByText('Alice Reviewer (alice)')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/members/m1')
    })
  })

  it('adds a new member with the selected roles', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (init?.method === 'POST') {
        return jsonResponse(
          {
            id: 'm2',
            userId: 'u2',
            canTitleAbstractScreen: false,
            canFullTextScreen: true,
            canExtract: false,
            canAssessQuality: false,
            canAdjudicate: false,
            workloadWeight: 1,
          },
          201,
        )
      }
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    await screen.findByText('Alice Reviewer (alice)')
    fireEvent.change(screen.getByLabelText('Reviewer'), { target: { value: 'u2' } })
    fireEvent.click(screen.getByLabelText('Full-text screening'))
    fireEvent.click(screen.getByRole('button', { name: 'Add Member' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/members')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        userId: 'u2',
        canTitleAbstractScreen: false,
        canFullTextScreen: true,
        canExtract: false,
        canAssessQuality: false,
        canAdjudicate: false,
        workloadWeight: 1,
      })
    })
  })
})
