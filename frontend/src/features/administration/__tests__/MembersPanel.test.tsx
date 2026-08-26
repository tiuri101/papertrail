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

// Alice owns the project; Bob is an ordinary member.
const ownedProjectDetail = {
  id: 'p1',
  memberships: [
    { ...projectDetail.memberships[0], isOwner: true },
    {
      id: 'm2',
      userId: 'u2',
      canTitleAbstractScreen: false,
      canFullTextScreen: true,
      canExtract: false,
      canAssessQuality: false,
      canAdjudicate: false,
      workloadWeight: 1,
      isOwner: false,
    },
  ],
}

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

  // Consumer updates for Group C: a project always has exactly one owner, so
  // the owner's row cannot offer a plain Remove.
  it('marks the owner and offers a transfer instead of a removal', async () => {
    mockFetch((input) => {
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(ownedProjectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    const ownerRow = (await screen.findByText('Alice Reviewer (alice)')).closest('tr') as HTMLElement
    expect(within(ownerRow).getByText('Owner')).toBeInTheDocument()
    expect(within(ownerRow).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(within(ownerRow).getByRole('button', { name: 'Transfer Ownership' })).toBeInTheDocument()

    const memberRow = screen.getByText('Bob Reviewer (bob)').closest('tr') as HTMLElement
    expect(within(memberRow).queryByText('Owner')).not.toBeInTheDocument()
    expect(within(memberRow).getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  })

  it('transfers ownership to another member', async () => {
    const fetchMock = mockFetch((input, init) => {
      if (String(input).endsWith('/transfer-ownership') && init?.method === 'POST') {
        return jsonResponse(ownedProjectDetail)
      }
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(ownedProjectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    const ownerRow = (await screen.findByText('Alice Reviewer (alice)')).closest('tr') as HTMLElement
    fireEvent.click(within(ownerRow).getByRole('button', { name: 'Transfer Ownership' }))

    const select = await screen.findByLabelText('New owner')
    // Only existing members other than the current owner can take it over.
    const optionValues = Array.from((select as HTMLSelectElement).options).map((option) => option.value)
    expect(optionValues).toEqual(['', 'u2'])

    fireEvent.change(select, { target: { value: 'u2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Transfer' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/transfer-ownership') && init?.method === 'POST',
      )
      expect(String(call?.[0])).toBe('/api/v1/projects/p1/transfer-ownership')
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ userId: 'u2' })
    })
  })

  it('explains a refused owner removal instead of showing a bare conflict', async () => {
    // A stale tab still showing a Remove on what has since become the owner's
    // row: the backend refuses it, and the reason has to reach the user.
    mockFetch((input, init) => {
      if (init?.method === 'DELETE') {
        return jsonResponse(
          {
            error: {
              code: 'project_ownership_required',
              message: 'A project must always have an owner. Transfer ownership before removing this member.',
            },
          },
          409,
        )
      }
      if (String(input).endsWith('/member-candidates')) return jsonResponse(users)
      return jsonResponse(projectDetail)
    })
    renderWithProviders(<MembersPanel projectId="p1" />)

    const row = (await screen.findByText('Alice Reviewer (alice)')).closest('tr') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(row).getByRole('button', { name: 'Confirm' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A project must always have an owner. Transfer ownership before removing this member.',
    )
  })
})
