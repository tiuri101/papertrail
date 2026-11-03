import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { DuplicateDecisionButtons } from '../DuplicateDecisionButtons'

function renderButtons(props: Partial<Parameters<typeof DuplicateDecisionButtons>[0]> = {}) {
  return render(
    <DuplicateDecisionButtons
      publicationAId="pub-a"
      publicationBId="pub-b"
      onMerge={vi.fn()}
      onNotDuplicate={vi.fn()}
      {...props}
    />,
  )
}

describe('DuplicateDecisionButtons', () => {
  it('marks the recommended choice with a "Suggested" tag', () => {
    renderButtons({ recommended: 'b' })
    expect(
      within(screen.getByRole('button', { name: 'Keep Record B' })).getByText('Suggested'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('button', { name: 'Keep Record A' })).queryByText('Suggested'),
    ).not.toBeInTheDocument()
  })

  it('drops the "Suggested" tag when the recommendation is already the choice on record', () => {
    renderButtons({ recommended: 'a', current: 'a' })
    expect(screen.queryByText('Suggested')).not.toBeInTheDocument()
  })

  it('only lets the screened record be kept when exactly one record is screened', () => {
    renderButtons({ screenedA: true, screenedB: false })
    const keepB = screen.getByRole('button', { name: 'Keep Record B' })
    expect(keepB).toBeDisabled()
    expect(within(keepB).getByText('Record A has screening decisions, so it must be kept')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep Record A' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Not a Duplicate' })).toBeEnabled()
  })

  it('leaves the choice open when both records are screened', () => {
    renderButtons({ screenedA: true, screenedB: true })
    expect(screen.getByRole('button', { name: 'Keep Record A' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Keep Record B' })).toBeEnabled()
  })
})
