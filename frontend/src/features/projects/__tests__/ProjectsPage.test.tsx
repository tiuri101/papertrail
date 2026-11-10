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
    expect(within(projectCard).getByText('Draft')).toHaveAttribute('data-project-stage', 'draft')
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

    fireEvent.click(
        await screen.findByRole('button', { name: 'Get Started' }),
    )

    expect(await screen.findByText('Setup wizard placeholder')).toBeInTheDocument()
  })

  it('keeps the create-project affordance reachable with zero projects', async () => {
    mockFetch(async () => jsonResponse([]))

    renderWithProviders(<ProjectsPage />)

    expect(await screen.findByRole('heading', { name: 'Create New Project' })).toBeVisible()
    expect(screen.getByText('No projects yet. Create your first project to get started.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Get Started' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New Project' })).not.toBeInTheDocument()
  })

  it('sorts the project list', async () => {
    mockFetch(async () => jsonResponse([
      {
        id: 'p1',
        name: 'Zebra review',
        description: null,
        reviewType: 'systematic_review',
        stage: 'draft',
        createdAt: '2026-08-01T10:00:00Z',
        updatedAt: '2026-08-10T10:00:00Z',
        owner: { id: 'u1', displayName: 'Ada Lovelace' },
        myRole: 'owner',
        openTaskCount: 0,
        primaryLabel: 'Imported',
        primaryCount: 0,
        secondaryLabel: 'Screened',
        secondaryCount: 0,
        reviewerCount: 1,
        percentComplete: 20,
      },
      {
        id: 'p2',
        name: 'Alpha review',
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
        percentComplete: 90,
      },
    ]))

    renderWithProviders(<ProjectsPage />)

    await screen.findByRole('link', { name: 'Alpha review' })
    const list = screen.getByRole('list', { name: 'Projects' })
    const projectNames = () =>
      within(list)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent)
        .filter((name) => name !== 'Create New Project')

    expect(projectNames()).toEqual(['Alpha review', 'Zebra review'])

    fireEvent.change(screen.getByLabelText('Sort projects'), { target: { value: 'updated' } })
    expect(projectNames()).toEqual(['Alpha review', 'Zebra review'])

    fireEvent.change(screen.getByLabelText('Sort projects'), { target: { value: 'created' } })
    expect(projectNames()).toEqual(['Zebra review', 'Alpha review'])

    fireEvent.change(screen.getByLabelText('Sort projects'), { target: { value: 'completion' } })
    expect(projectNames()).toEqual(['Alpha review', 'Zebra review'])
  })
  it('switches to the archived projects view and back', async () => {
    const archivedProject = {
      id: 'p9',
      name: 'Old review',
      description: null,
      reviewType: 'systematic_review',
      stage: 'completed',
      archivedAt: '2026-10-01T10:00:00Z',
      createdAt: '2025-01-01T10:00:00Z',
      updatedAt: '2026-10-01T10:00:00Z',
      owner: { id: 'u1', displayName: 'Ada Lovelace' },
      myRole: 'owner',
      openTaskCount: 0,
      primaryLabel: 'Included',
      primaryCount: 4,
      secondaryLabel: 'Screened',
      secondaryCount: 10,
      reviewerCount: 1,
      percentComplete: 100,
    }
    const fetchMock = mockFetch(async (input) =>
      jsonResponse(String(input).includes('archived=true') ? [archivedProject] : []),
    )

    renderWithProviders(<ProjectsPage />, { route: '/projects' })

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Archived projects' }))

    expect(await screen.findByRole('heading', { name: 'Archived Projects' })).toBeVisible()
    const projectLink = await screen.findByRole('link', { name: 'Old review' })
    expect(within(projectLink.closest('li') as HTMLLIElement).getByText(/^Archived /)).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Create New Project' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('/api/v1/projects?archived=true')

    fireEvent.click(screen.getByRole('button', { name: 'Active projects' }))
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Old review' })).not.toBeInTheDocument()
  })
})
