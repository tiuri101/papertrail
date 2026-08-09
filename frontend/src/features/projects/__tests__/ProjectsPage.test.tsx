import { fireEvent, screen } from '@testing-library/react'
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
        reviewType: 'systematic_review',
        stage: 'draft',
      },
    ]))

    renderWithProviders(<ProjectsPage />)

    expect(
        await screen.findByRole('link', { name: 'Existing review' }),
    ).toHaveAttribute('href', '/projects/p1')
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
