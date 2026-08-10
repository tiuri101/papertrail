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
        owner: { id: 'u1', displayName: 'Ada Lovelace' },
        myRole: 'owner',
        openTaskCount: 3,
      },
      {
        id: 'p2',
        name: 'Secondary review',
        description: null,
        reviewType: 'scoping_review',
        stage: 'completed',
        createdAt: '2026-07-15T10:00:00Z',
        owner: { id: 'u2', displayName: 'Grace Hopper' },
        myRole: 'reviewer',
        openTaskCount: 0,
      },
    ]))

    renderWithProviders(<ProjectsPage />)

    const projectLink = await screen.findByRole('link', { name: 'Existing review' })
    expect(projectLink).toHaveAttribute('href', '/projects/p1')
    expect(screen.getByText('Systematic review', { selector: '.review-type-badge' })).toHaveClass(
      'review-type-badge',
      'review-type-badge--systematic-review',
    )
    const projectCard = projectLink.closest('li') as HTMLLIElement
    const cardBadges = projectCard.querySelector('.project-card__badges') as HTMLParagraphElement
    expect(within(projectCard).getByText('3 open tasks')).toHaveClass('project-task-badge--open')
    expect(within(cardBadges).getByText('Owner', { selector: '.project-role-badge' })).toBeInTheDocument()
    expect(within(projectCard).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(projectCard).getByText(/2026/, { selector: 'time' })).toHaveAttribute(
      'datetime',
      '2026-08-01T10:00:00Z',
    )
    expect(within(screen.getByLabelText('My role')).queryByRole('option', { name: 'Administrator' }))
      .not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('My role'), { target: { value: 'reviewer' } })
    expect(screen.queryByRole('link', { name: 'Existing review' })).not.toBeInTheDocument()
    const secondaryLink = screen.getByRole('link', { name: 'Secondary review' })
    expect(secondaryLink).toBeInTheDocument()
    expect(within(secondaryLink.closest('li') as HTMLLIElement).getByText('No open tasks')).toHaveClass(
      'project-task-badge--clear',
    )

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
