import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { setCsrfToken } from '../features/auth/session'

window.scrollTo = () => {}
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {})

// jsdom has no ResizeObserver; recharts' ResponsiveContainer requires one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = window.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver)

// jsdom has no matchMedia; approximate max-width queries against window.innerWidth so
// components using CSS-breakpoint-driven behavior (e.g. mobile-only interactions) are testable.
window.matchMedia = window.matchMedia ?? ((query: string) => {
  const match = /max-width:\s*(\d+)px/.exec(query)
  const maxWidth = match ? Number(match[1]) : Infinity
  return {
    matches: window.innerWidth <= maxWidth,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as MediaQueryList
})

afterEach(() => {
  cleanup()
  setCsrfToken(null)
})
