import { describe, expect, it } from 'vitest'

import {
  hasOriginPermission,
  hasPublisherAccess,
  originPattern,
  requestOriginPermission,
  requestPublisherAccess,
} from '../src/retrieval/permission-manager'
import { installChromeMock } from './chrome-mock'

describe('originPattern', () => {
  it('builds an exact origin pattern from a URL', () => {
    expect(originPattern('https://link.springer.com/article/10.1007/x')).toBe('https://link.springer.com/*')
  })
})

describe('hasOriginPermission', () => {
  it('returns true when the permission is already granted', async () => {
    const chromeMock = installChromeMock({ permissionsContains: async () => true })

    const result = await hasOriginPermission('https://link.springer.com/*')

    expect(result).toBe(true)
    expect(chromeMock.permissions.contains).toHaveBeenCalledWith({ origins: ['https://link.springer.com/*'] })
  })

  it('returns false when the permission has not been granted', async () => {
    installChromeMock({ permissionsContains: async () => false })

    expect(await hasOriginPermission('https://dl.acm.org/*')).toBe(false)
  })
})

describe('requestOriginPermission', () => {
  it('returns true when the user grants the request', async () => {
    const chromeMock = installChromeMock({ permissionsRequest: async () => true })

    const result = await requestOriginPermission('https://dl.acm.org/*')

    expect(result).toBe(true)
    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ origins: ['https://dl.acm.org/*'] })
  })

  it('returns false when the user denies the request', async () => {
    installChromeMock({ permissionsRequest: async () => false })

    expect(await requestOriginPermission('https://dl.acm.org/*')).toBe(false)
  })
})

describe('hasPublisherAccess / requestPublisherAccess', () => {
  it('checks and requests the single broad https://*/* grant, not a per-site one', async () => {
    const chromeMock = installChromeMock({
      permissionsContains: async () => false,
      permissionsRequest: async () => true,
    })

    expect(await hasPublisherAccess()).toBe(false)
    expect(chromeMock.permissions.contains).toHaveBeenCalledWith({ origins: ['https://*/*'] })

    expect(await requestPublisherAccess()).toBe(true)
    expect(chromeMock.permissions.request).toHaveBeenCalledWith({ origins: ['https://*/*'] })
  })
})
