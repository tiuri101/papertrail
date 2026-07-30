import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectsPage } from '../ProjectsPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectsPage', () => {
  it('lists projects and creates a new project', async () => {
    const projects = [{ id: 'p1', name: 'Existing review', reviewType: 'systematic_review', stage: 'draft' }]
    mockFetch(async (_input, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        const project = { id: 'p2', ...body, stage: 'draft' }
        projects.push(project)
        return jsonResponse(project, 201)
      }
      return jsonResponse(projects)
    })

    renderWithProviders(<ProjectsPage />)
    expect(await screen.findByRole('link', { name: 'Existing review' })).toHaveAttribute('href', '/projects/p1')

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Urban VR review' } })
    fireEvent.change(screen.getByLabelText('Review type'), { target: { value: 'systematic_mapping' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('link', { name: 'Urban VR review' })).toHaveAttribute('href', '/projects/p2')
    expect(screen.getByLabelText('Project name')).toHaveValue('')
  })

  it('shows project creation errors', async () => {
    mockFetch(async (_input, init) => init?.method === 'POST'
      ? jsonResponse({ error: { message: 'Project name is already used' } }, 409)
      : jsonResponse([]))
    renderWithProviders(<ProjectsPage />)
    await screen.findByRole('heading', { name: 'Projects' })

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Duplicate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Project name is already used'))
  })
})
