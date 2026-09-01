import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { InfoBox } from '../InfoBox'

describe('InfoBox', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('renders without a dismiss button by default', () => {
    render(<InfoBox icon={<span />}><p>Default hint</p></InfoBox>)

    expect(screen.getByText('Default hint')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })

  it('hides itself and remembers the dismissal in localStorage when closed', () => {
    const { unmount } = render(
      <InfoBox icon={<span />} closable id="test-hint"><p>Closable hint</p></InfoBox>,
    )

    expect(screen.getByText('Closable hint')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Closable hint')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('papertrail-infobox-dismissed:test-hint')).toBe('1')

    unmount()
    render(<InfoBox icon={<span />} closable id="test-hint"><p>Closable hint</p></InfoBox>)
    expect(screen.queryByText('Closable hint')).not.toBeInTheDocument()
  })

  it('keeps different infobox ids independent', () => {
    render(<InfoBox icon={<span />} closable id="hint-a"><p>Hint A</p></InfoBox>)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    render(<InfoBox icon={<span />} closable id="hint-b"><p>Hint B</p></InfoBox>)
    expect(screen.getByText('Hint B')).toBeVisible()
  })
})
