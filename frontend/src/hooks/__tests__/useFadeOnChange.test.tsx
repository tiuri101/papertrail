import { render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useFadeOnChange } from '../useFadeOnChange'

function Harness({ changeKey }: { changeKey: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useFadeOnChange(ref, changeKey)
  return <div ref={ref} data-testid="panel" />
}

describe('useFadeOnChange', () => {
  const originalMatchMedia = window.matchMedia
  const animate = vi.fn()

  beforeEach(() => {
    animate.mockReset()
    HTMLElement.prototype.animate = animate as unknown as HTMLElement['animate']
    window.matchMedia = ((query: string) => ({ matches: false, media: query }) as MediaQueryList)
  })

  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate
    window.matchMedia = originalMatchMedia
  })

  it('does not animate on first mount, only when the key changes', () => {
    const { rerender } = render(<Harness changeKey="a" />)
    expect(animate).not.toHaveBeenCalled()

    rerender(<Harness changeKey="a" />)
    expect(animate).not.toHaveBeenCalled()

    rerender(<Harness changeKey="b" />)
    expect(animate).toHaveBeenCalledTimes(1)
  })

  it('skips the animation when the user prefers reduced motion', () => {
    window.matchMedia = ((query: string) => ({ matches: query.includes('reduce'), media: query }) as MediaQueryList)
    const { rerender } = render(<Harness changeKey="a" />)

    rerender(<Harness changeKey="b" />)

    expect(animate).not.toHaveBeenCalled()
  })
})
