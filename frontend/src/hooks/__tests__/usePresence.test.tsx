import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePresence } from '../usePresence'

function Harness({ duration }: { duration?: string }) {
  const [open, setOpen] = useState(true)
  const { present, ref, state } = usePresence<HTMLDivElement>(open)
  return (
    <>
      <button type="button" onClick={() => setOpen((current) => !current)}>toggle</button>
      {present ? <div ref={ref} data-testid="panel" data-state={state} style={duration ? { transitionProperty: 'opacity', transitionDuration: duration } : undefined} /> : null}
    </>
  )
}

describe('usePresence', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('unmounts immediately when the element has no transition', () => {
    render(<Harness />)
    expect(screen.getByTestId('panel')).toHaveAttribute('data-state', 'open')

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))

    expect(screen.queryByTestId('panel')).not.toBeInTheDocument()
  })

  it('keeps the element mounted in the closed state until its transition ends', () => {
    vi.useFakeTimers()
    render(<Harness duration="150ms" />)

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    const panel = screen.getByTestId('panel')
    expect(panel).toHaveAttribute('data-state', 'closed')

    act(() => {
      panel.dispatchEvent(new Event('transitionend'))
    })
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument()
  })

  it('falls back to a timer when transitionend never fires', () => {
    vi.useFakeTimers()
    render(<Harness duration="150ms" />)

    fireEvent.click(screen.getByRole('button', { name: 'toggle' }))
    expect(screen.getByTestId('panel')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument()
  })

  it('returns to the open state if reopened mid-exit', () => {
    vi.useFakeTimers()
    render(<Harness duration="150ms" />)
    const toggle = screen.getByRole('button', { name: 'toggle' })

    fireEvent.click(toggle)
    fireEvent.click(toggle)
    act(() => {
      vi.advanceTimersByTime(250)
    })

    expect(screen.getByTestId('panel')).toHaveAttribute('data-state', 'open')
  })
})
