import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { setCsrfToken } from '../features/auth/session'

window.scrollTo = () => {}

// jsdom has no ResizeObserver; recharts' ResponsiveContainer requires one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = window.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver)

afterEach(() => {
  cleanup()
  setCsrfToken(null)
})
