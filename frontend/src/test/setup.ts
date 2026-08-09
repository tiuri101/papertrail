import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { setCsrfToken } from '../features/auth/session'

window.scrollTo = () => {}

afterEach(() => {
  cleanup()
  setCsrfToken(null)
})
