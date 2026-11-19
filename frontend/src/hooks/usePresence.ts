import { useLayoutEffect, useRef, useState } from 'react'

/** Extra slack before the fallback timer unmounts, in case `transitionend` never fires. */
const FALLBACK_SLACK_MS = 50

function parseTimeMs(value: string): number {
  const trimmed = value.trim()
  if (trimmed.endsWith('ms')) return parseFloat(trimmed) || 0
  if (trimmed.endsWith('s')) return (parseFloat(trimmed) || 0) * 1000
  return 0
}

/** Longest `transition-duration + transition-delay` currently computed for the element. */
function longestTransitionMs(element: Element): number {
  const style = getComputedStyle(element)
  const durations = (style.transitionDuration || '').split(',')
  const delays = (style.transitionDelay || '').split(',')
  return durations.reduce((longest, duration, index) => {
    const delay = delays[index % delays.length] ?? '0s'
    return Math.max(longest, parseTimeMs(duration) + parseTimeMs(delay))
  }, 0)
}

export type PresenceState = 'open' | 'closed'

/**
 * Keeps an element mounted while its CSS exit transition runs.
 *
 * Render the element while `present` is true, attach `ref`, and expose `state`
 * as `data-state` so styles can target `data-[state=closed]:` for the exit.
 * Entry is handled purely in CSS (Tailwind's `starting:` variant).
 *
 * When the element has no computed transition — reduced motion, or jsdom in
 * tests, where no stylesheet is loaded — it unmounts immediately, so closing
 * behaves exactly as an un-animated conditional render.
 */
export function usePresence<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null)
  const [present, setPresent] = useState(open)
  // Adjusting state during render (rather than in an effect) avoids painting a
  // frame where the element is open but not yet tracked as present.
  if (open && !present) setPresent(true)

  useLayoutEffect(() => {
    if (open || !present) return undefined
    const element = ref.current
    const duration = element ? longestTransitionMs(element) : 0
    if (!element || duration < 1) {
      setPresent(false)
      return undefined
    }
    const finish = () => setPresent(false)
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target === element) finish()
    }
    element.addEventListener('transitionend', handleTransitionEnd)
    const timer = window.setTimeout(finish, duration + FALLBACK_SLACK_MS)
    return () => {
      element.removeEventListener('transitionend', handleTransitionEnd)
      window.clearTimeout(timer)
    }
  }, [open, present])

  const state: PresenceState = open ? 'open' : 'closed'
  return { present: open || present, ref, state }
}
