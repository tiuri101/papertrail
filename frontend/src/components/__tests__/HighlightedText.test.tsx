import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { HighlightedText } from '../HighlightedText'

describe('HighlightedText', () => {
  it('wraps matching keywords in <mark>, case-insensitively', () => {
    render(<HighlightedText text="A study of Virtual Reality in urban analytics" keywords={['virtual reality', 'urban analytics']} />)

    const marks = screen.getAllByText((_, element) => element?.tagName === 'MARK', { selector: 'mark' })
    expect(marks.map((mark) => mark.textContent)).toEqual(['Virtual Reality', 'urban analytics'])
  })

  it('renders plain text unchanged when there are no keywords', () => {
    const { container } = render(<HighlightedText text="No keywords configured" keywords={[]} />)
    expect(container.querySelector('mark')).toBeNull()
    expect(screen.getByText('No keywords configured')).toBeInTheDocument()
  })

  it('does not treat keyword characters as regex syntax', () => {
    render(<HighlightedText text="Cost (in USD) analysis" keywords={['(in USD)']} />)
    const mark = document.querySelector('mark')
    expect(mark?.textContent).toBe('(in USD)')
  })
})
