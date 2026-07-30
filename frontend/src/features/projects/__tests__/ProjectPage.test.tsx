import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProjectPage } from '../ProjectPage'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

describe('ProjectPage', () => {
  it('renders project context, status, checklist, and a stage-aware workflow nav', async () => {
    mockFetch((input) => {
      const url = String(input)
      if (url.endsWith('/checklist')) {
        return jsonResponse({
          stage: 'title_abstract_screening',
          stages: [
            {
              stage: 'title_abstract_screening',
              label: 'Title/abstract screening',
              isCurrent: true,
              isComplete: false,
              autoAdvances: true,
              action: null,
              items: [{ key: 'title_abstract_decisions', label: 'Reach a final decision for every publication', done: false, detail: '0 of 10 decided' }],
            },
          ],
        })
      }
      if (url.endsWith('/dashboard')) {
        return jsonResponse({ stage: 'title_abstract_screening', unresolvedDuplicates: 0 })
      }
      return jsonResponse({
        id: 'p1',
        name: 'Immersive analytics review',
        stage: 'title_abstract_screening',
      })
    })
    renderWithProviders(<ProjectPage />, { route: '/projects/p1', path: '/projects/:projectId' })

    expect(await screen.findByRole('heading', { name: 'Immersive analytics review' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Title/abstract screening' })).toHaveAttribute('href', '/projects/p1/screening/title_abstract')
    expect(screen.getByRole('link', { name: 'Reporting and exports' })).toHaveAttribute('href', '/projects/p1/reporting')

    const currentStage = screen.getByRole('listitem', { current: 'step' })
    expect(currentStage).toHaveTextContent('Title/abstract screening')
    const draftStage = screen.getAllByRole('listitem').find((item) => item.textContent === 'Draft')
    expect(draftStage).not.toHaveAttribute('aria-current')

    expect(await screen.findByText("What's next: Title/abstract screening")).toBeInTheDocument()
    expect(screen.getByText(/Reach a final decision for every publication/)).toBeInTheDocument()

    expect(await screen.findByText('Project status')).toBeInTheDocument()
    expect(screen.getByRole('rowheader', { name: 'Unresolved duplicates' })).toBeInTheDocument()

    const currentGroupHeading = screen.getAllByText('Title/abstract screening').find((el) => el.tagName === 'H3')
    const currentGroup = currentGroupHeading?.closest('.nav-group')
    expect(currentGroup).not.toHaveClass('nav-group--upcoming')
    const pastGroup = screen.getByText('Deduplication').closest('.nav-group')
    expect(pastGroup).not.toHaveClass('nav-group--upcoming')
    const upcomingGroupHeading = screen.getAllByText('Extraction & quality').find((el) => el.tagName === 'H3')
    const upcomingGroup = upcomingGroupHeading?.closest('.nav-group')
    expect(upcomingGroup).toHaveClass('nav-group--upcoming')
    const setupGroup = screen.getByText('Setup & configuration').closest('.nav-group')
    expect(setupGroup).not.toHaveClass('nav-group--upcoming')

    expect(screen.getByRole('heading', { name: 'Actions' }).closest('.card')).toContainElement(
      screen.getByRole('navigation', { name: 'Project workflow' }),
    )
    expect(screen.queryByRole('link', { name: 'Data extraction' })).not.toBeInTheDocument()
    const disabledExtraction = screen.getByText('Data extraction')
    expect(disabledExtraction.tagName).toBe('SPAN')
    expect(disabledExtraction).toHaveAttribute('aria-disabled', 'true')
  })
})
