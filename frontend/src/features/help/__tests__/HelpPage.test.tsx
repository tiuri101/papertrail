import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HelpPage } from '../HelpPage'
import { renderWithProviders } from '../../../test/render'

describe('HelpPage', () => {
  it('describes the app and both roles for every project stage', () => {
    renderWithProviders(<HelpPage />)

    expect(screen.getByRole('heading', { name: 'Help' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'What Papertrail Does' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'The Review Stages' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'As a Project Owner' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'As a Reviewer' })).toBeInTheDocument()

    const ownerHeadings = screen.getAllByRole('heading', { name: 'Extraction & Quality Assessment' })
    const reviewerHeadings = screen.getAllByRole('heading', { name: 'Completed' })
    expect(ownerHeadings.length).toBeGreaterThan(0)
    expect(reviewerHeadings.length).toBeGreaterThan(0)
  })

  it('numbers all six review stages in order with their colors', () => {
    renderWithProviders(<HelpPage />)

    const timeline = screen.getByRole('list', { name: 'Review stages' })
    const items = Array.from(timeline.querySelectorAll('.help-stage-timeline__item'))
    expect(items).toHaveLength(6)
    expect(items[0]).toHaveTextContent('1')
    expect(items[0]).toHaveTextContent('Draft')
    expect(items[5]).toHaveTextContent('6')
    expect(items[5]).toHaveTextContent('Completed')
  })

  it('styles reviewer and project owner guidance as matching stage timelines', () => {
    renderWithProviders(<HelpPage />)

    for (const label of ['Reviewer responsibilities by stage', 'Project owner responsibilities by stage']) {
      const timeline = screen.getByRole('list', { name: label })
      const items = Array.from(timeline.querySelectorAll('.help-stage-timeline__item'))

      expect(timeline).toHaveClass('help-stage-timeline--responsibilities')
      expect(items).toHaveLength(6)
      expect(items[0].querySelector('.help-stage-timeline__number')).toHaveTextContent('1')
      expect(items[0]).toHaveStyle({ '--stage-color': '#2a78d6' })
      expect(items[5].querySelector('.help-stage-timeline__number')).toHaveTextContent('6')
      expect(items[5]).toHaveStyle({ '--stage-color': '#008300' })
    }
  })
})
