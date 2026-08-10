import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CollapsibleSection } from '../CollapsibleSection'
import { renderWithProviders } from '../../test/render'

describe('CollapsibleSection', () => {
  it('toggles its content without discarding child state', () => {
    renderWithProviders(
      <CollapsibleSection title="Project Details">
        <label>
          Name
          <input defaultValue="Evidence review" />
        </label>
      </CollapsibleSection>,
    )

    const toggle = screen.getByRole('button', { name: 'Project Details' })
    const input = screen.getByRole('textbox', { name: 'Name' })
    const content = document.getElementById(toggle.getAttribute('aria-controls')!)
    fireEvent.change(input, { target: { value: 'Updated review' } })

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(content).toHaveAttribute('data-expanded', 'false')
    expect(content).toHaveAttribute('aria-hidden', 'true')
    expect(content).toHaveAttribute('inert')
    expect(content).not.toHaveAttribute('hidden')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(content).toHaveAttribute('data-expanded', 'true')
    expect(content).toHaveAttribute('aria-hidden', 'false')
    expect(content).not.toHaveAttribute('inert')
    expect(input).toBeVisible()
    expect(input).toHaveValue('Updated review')
  })
})
