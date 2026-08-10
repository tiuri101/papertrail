import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'
import { ProjectSectionLayout } from '../ProjectSectionLayout'

describe('ProjectSectionLayout', () => {
  it('shows the project name on subpages and includes it in the browser title', async () => {
    document.title = 'Papertrail'
    mockFetch(() => jsonResponse({ id: 'p1', name: 'Evidence synthesis' }))

    const { unmount } = renderWithProviders(
      <Routes>
        <Route element={<ProjectSectionLayout />}>
          <Route path="/projects/:projectId/jobs" element={<main><h1>Jobs</h1></main>} />
        </Route>
      </Routes>,
      { route: '/projects/p1/jobs' },
    )

    const projectLinks = await screen.findAllByRole('link', { name: /Evidence synthesis/ })
    expect(projectLinks).not.toHaveLength(0)
    expect(projectLinks.every((link) => link.getAttribute('href') === '/projects/p1')).toBe(true)
    expect(document.title).toBe('Evidence synthesis · Papertrail')

    unmount()
    expect(document.title).toBe('Papertrail')
  })
})
