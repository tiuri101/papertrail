import { afterEach, describe, expect, it, vi } from 'vitest'

import { safeRedirectFetch } from '../src/retrieval/redirect-fetch'

/** `fetch()` normally sets `url`/`redirected` internally as the browser
 * follows a redirect chain; a plain `new Response()` in tests doesn't, so
 * this fakes what a followed-through response looks like. */
function finalResponse(
  url: string,
  body: string,
  init: ResponseInit & { redirected?: boolean } = {},
): Response {
  const response = new Response(body, { status: 200, ...init })
  Object.defineProperty(response, 'url', { value: url })
  Object.defineProperty(response, 'redirected', { value: init.redirected ?? false })
  return response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('safeRedirectFetch', () => {
  it('returns the final response after the browser follows a redirect chain', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      finalResponse('https://publisher.example.org/final', '<html>final</html>', { redirected: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await safeRedirectFetch('https://publisher.example.org/start')

    expect(result.finalUrl).toBe('https://publisher.example.org/final')
    expect(result.redirected).toBe(true)
    expect(await result.response.text()).toBe('<html>final</html>')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.example.org/start',
      expect.objectContaining({ credentials: 'include', redirect: 'follow' }),
    )
  })

  it('follows a chain through a plain-http intermediate hop transparently (handled by the browser, not this code)', async () => {
    // Mirrors IEEE Xplore: doi.org bounces through a plain http:// document
    // URL that IEEE's own server immediately upgrades to https. This is
    // handled entirely by the browser's own redirect-following -- this code
    // only ever sees the final response, never the intermediate hop.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      finalResponse('https://ieeexplore.ieee.org/document/7892377/', '<html>final</html>', { redirected: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await safeRedirectFetch('https://doi.org/10.1109/VR.2017.7892377')

    expect(result.finalUrl).toBe('https://ieeexplore.ieee.org/document/7892377/')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses to trust a final response served over plain http', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      finalResponse('http://publisher.example.org/final', '<html>insecure</html>'),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeRedirectFetch('https://publisher.example.org/start')).rejects.toThrow(/unsafe/i)
  })

  it('refuses to trust a final response that redirected to a private/local target', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      finalResponse('https://169.254.169.254/latest/meta-data', 'secret', { redirected: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeRedirectFetch('https://publisher.example.org/start')).rejects.toThrow(/unsafe/i)
  })

  it('refuses to fetch an unsafe starting URL', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(safeRedirectFetch('file:///etc/passwd')).rejects.toThrow(/unsafe/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
