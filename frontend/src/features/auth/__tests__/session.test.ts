import { describe, expect, it } from 'vitest'

import { getCsrfToken, setCsrfToken } from '../session'

describe('CSRF session state', () => {
  it('stores and clears the current token', () => {
    setCsrfToken('token')
    expect(getCsrfToken()).toBe('token')
    setCsrfToken(null)
    expect(getCsrfToken()).toBeNull()
  })
})
