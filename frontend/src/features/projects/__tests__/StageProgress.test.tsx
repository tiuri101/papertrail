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
      'Duplicate Review',
      'Title/Abstract Screening',
      'Full-Text Screening',
      'Extraction & Quality',
      'Completed',
    ])

    const current = screen.getByRole('listitem', { current: 'step' })
    expect(current).toHaveTextContent('Full-Text Screening')
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
