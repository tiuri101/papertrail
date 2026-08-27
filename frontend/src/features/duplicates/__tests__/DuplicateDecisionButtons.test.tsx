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
})
