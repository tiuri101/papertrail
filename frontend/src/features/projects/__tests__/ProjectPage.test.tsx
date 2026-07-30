import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectPage } from '../ProjectPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectPage', () => {
  it('renders project context and all workflow destinations', async () => {
    mockFetch(() => jsonResponse({
      id: 'p1',
      name: 'Immersive analytics review',
      stage: 'title_abstract_screening',
      researchQuestions: [{ id: 'rq1', text: 'How is urban data visualized in VR?' }],
      criteria: [
        { id: 'c1', kind: 'inclusion', text: 'Uses immersive technology' },
        { id: 'c2', kind: 'exclusion', text: 'Non-peer-reviewed publication' },
      ],
    }))
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    expect(await screen.findByRole('heading', { name: 'Immersive analytics review' })).toBeInTheDocument()
    expect(screen.getByText('How is urban data visualized in VR?')).toBeInTheDocument()
    expect(screen.getByText(/Uses immersive technology/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Title/abstract screening' })).toHaveAttribute('href', '/projects/p1/screening/title_abstract')
    expect(screen.getByRole('link', { name: 'Reporting and exports' })).toHaveAttribute('href', '/projects/p1/reporting')
  })
})
