import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveDoiUrl } from '../src/retrieval/doi-resolver'

function handleResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveDoiUrl', () => {
  it('extracts the URL value from a real-shaped Handle API response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(handleResponse({
      responseCode: 1,
      handle: '10.1109/vr.2017.7892377',
      values: [
        { index: 1, type: 'URL', data: { format: 'string', value: 'http://ieeexplore.ieee.org/document/7892377/' } },
        { index: 700050, type: '700050', data: { format: 'string', value: '20170406160056972' } },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolveDoiUrl('10.1109/vr.2017.7892377')

    expect(result).toBe('https://ieeexplore.ieee.org/document/7892377/')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://doi.org/api/handles/10.1109%2Fvr.2017.7892377',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    )
  })

  it('leaves an already-https URL value unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(handleResponse({
      values: [{ type: 'URL', data: { value: 'https://link.springer.com/article/10.1007/x' } }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await resolveDoiUrl('10.1007/x')).toBe('https://link.springer.com/article/10.1007/x')
  })

  it('returns null when the response has no URL value', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(handleResponse({
      values: [{ type: 'HS_ADMIN', data: { value: 'irrelevant' } }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await resolveDoiUrl('10.1109/vr.2017.7892377')).toBeNull()
  })

  it('returns null when the resolved URL is unsafe', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(handleResponse({
      values: [{ type: 'URL', data: { value: 'http://169.254.169.254/latest/meta-data' } }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await resolveDoiUrl('10.1000/xyz')).toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await resolveDoiUrl('10.1000/missing')).toBeNull()
  })

  it('returns null when the network request itself fails', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    expect(await resolveDoiUrl('10.1000/xyz')).toBeNull()
  })

  it('returns null on an unparseable JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('not json', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await resolveDoiUrl('10.1000/xyz')).toBeNull()
  })
})
