import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { StageProgress } from '../StageProgress'

describe('StageProgress', () => {
  it('marks the current stage and leaves the rest unmarked', () => {
    render(<StageProgress stage="full_text_screening" />)

    const steps = screen.getAllByRole('listitem')
    expect(steps).toHaveLength(6)
    expect(steps.map((step) => step.textContent)).toEqual([
      'Draft',
      'Duplicate review',
      'Title/abstract screening',
      'Full-text screening',
      'Extraction & quality',
      'Completed',
    ])

    const current = screen.getByRole('listitem', { current: 'step' })
    expect(current).toHaveTextContent('Full-text screening')
    expect(steps.filter((step) => step !== current)).toSatisfy((rest: HTMLElement[]) =>
      rest.every((step) => !step.hasAttribute('aria-current')),
    )
  })

  it('gives each stage a distinct background color', () => {
    render(<StageProgress stage="draft" />)
    const colors = screen.getAllByRole('listitem').map((step) => step.style.backgroundColor)
    expect(new Set(colors).size).toBe(colors.length)
  })
})
