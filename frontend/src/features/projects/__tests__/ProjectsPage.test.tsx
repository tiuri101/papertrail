import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Route, Routes } from 'react-router-dom'

import { ProjectsPage } from '../ProjectsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectsPage', () => {
  it('lists existing projects', async () => {
    mockFetch(async () => jsonResponse([
      {
        id: 'p1',
        name: 'Existing review',
        description: 'Virtual reality research',
        reviewType: 'systematic_review',
        stage: 'draft',
        createdAt: '2026-08-01T10:00:00Z',
        updatedAt: '2026-08-18T10:00:00Z',
        owner: { id: 'u1', displayName: 'Ada Lovelace' },
        myRole: 'owner',
        openTaskCount: 3,
        primaryLabel: 'Imported',
        primaryCount: 0,
        secondaryLabel: 'Screened',
        secondaryCount: 0,
        reviewerCount: 2,
        percentComplete: 0,
      },
      {
        id: 'p2',
        name: 'Secondary review',
        description: null,
        reviewType: 'scoping_review',
        stage: 'completed',
        createdAt: '2026-07-15T10:00:00Z',
        updatedAt: '2026-08-19T10:00:00Z',
        owner: { id: 'u2', displayName: 'Grace Hopper' },
        myRole: 'reviewer',
        openTaskCount: 0,
        primaryLabel: 'Included',
        primaryCount: 89,
        secondaryLabel: 'Screened',
        secondaryCount: 143,
        reviewerCount: 6,
        percentComplete: 100,
      },
    ]))

    renderWithProviders(<ProjectsPage />)

    expect(await screen.findByRole('list', { name: 'Projects' })).toBeVisible()
    const projectLink = await screen.findByRole('link', { name: 'Existing review' })
    expect(projectLink).toHaveAttribute('href', '/projects/p1')
    const projectCard = projectLink.closest('li') as HTMLLIElement
    expect(within(projectCard).getByText('Draft')).toHaveClass('stage-badge')
    expect(within(projectCard).getByText('Systematic review')).toBeVisible()
    expect(within(projectCard).getByText('Owner')).toBeVisible()
    expect(within(projectCard).queryByText('Owner: Ada Lovelace')).not.toBeInTheDocument()
    expect(within(projectCard).getByText('3 open tasks')).toBeVisible()

    expect(within(projectCard).getByRole('link', { name: 'Open Project' })).toHaveAttribute('href', '/projects/p1')
    expect(within(projectCard).getByRole('link', { name: 'Manage Existing review' })).toHaveAttribute(
      'href',
      '/projects/p1/admin',
    )
    expect(within(projectCard).getByText('2')).toBeInTheDocument()
    expect(within(projectCard).getByText('Reviewers')).toBeInTheDocument()

    const secondCard = screen.getByRole('link', { name: 'Secondary review' }).closest('li') as HTMLLIElement
    expect(within(secondCard).getByText('Owner: Grace Hopper')).toBeInTheDocument()
    expect(within(secondCard).getByText('Included')).toBeInTheDocument()
    expect(within(secondCard).getByText('89')).toBeInTheDocument()
    expect(within(secondCard).getByText('100%')).toBeInTheDocument()
    expect(within(secondCard).queryByRole('link', { name: 'Manage Secondary review' })).not.toBeInTheDocument()

    expect(within(screen.getByLabelText('My role')).queryByRole('option', { name: 'Administrator' }))
      .not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('My role'), { target: { value: 'reviewer' } })
    expect(screen.queryByRole('link', { name: 'Existing review' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Secondary review' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'Ada' } })
    expect(screen.getByRole('link', { name: 'Existing review' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Secondary review' })).not.toBeInTheDocument()
  })

  it('sends New Project to the guided setup wizard', async () => {
    mockFetch(async () => jsonResponse([]))

    renderWithProviders(
      <Routes>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<p>Setup wizard placeholder</p>} />
      </Routes>,
    )

    await screen.findByRole('heading', { name: 'Projects' })

    fireEvent.click(
        screen.getByRole('button', { name: 'New Project' }),
    )

    expect(await screen.findByText('Setup wizard placeholder')).toBeInTheDocument()
  })
})
