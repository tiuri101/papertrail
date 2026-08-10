import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { InfoTooltip, Tooltip } from '../Tooltip'

describe('Tooltip', () => {
  it('reveals the tooltip text on focus and hides it on blur', () => {
    render(
      <Tooltip text="Explains the wrapped content">
        <span>Background jobs</span>
      </Tooltip>,
    )

    const anchor = screen.getByText('Background jobs').closest('.tooltip-anchor')!
    const tooltip = screen.getByText('Explains the wrapped content')
    expect(tooltip).not.toBeVisible()

    fireEvent.focus(anchor)
    expect(tooltip).toBeVisible()

    fireEvent.blur(anchor)
    expect(tooltip).not.toBeVisible()
  })
})

describe('InfoTooltip', () => {
  it('reveals its text when the help icon receives focus', () => {
    render(<InfoTooltip text="More detail about this field" />)

    const trigger = screen.getByRole('button', { name: 'More information' })
    const tooltip = screen.getByText('More detail about this field')
    expect(tooltip).not.toBeVisible()

    fireEvent.focus(trigger)
    expect(tooltip).toBeVisible()

    fireEvent.blur(trigger)
    expect(tooltip).not.toBeVisible()
  })

  it('opens downward instead of upward when placement is "bottom"', () => {
    render(<InfoTooltip text="Opens below the trigger" placement="bottom" />)

    expect(screen.getByText('Opens below the trigger')).toHaveClass('tooltip-bubble--bottom')
  })
})
