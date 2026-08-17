import { isSafePublisherUrl } from './url-safety'

export interface RedirectFetchOptions {
  init?: RequestInit
}

export interface RedirectFetchResult {
  response: Response
  finalUrl: string
  redirected: boolean
}

/**
 * Fetches a URL and lets the browser follow any redirect chain itself
 * (`redirect: 'follow'`, the default).
 *
 * This used to peek at each redirect hop manually (`redirect: 'manual'`) to
 * validate every URL before following it, but that isn't viable for a
 * genuinely cross-origin chain: Chrome returns an opaque response
 * (`status: 0`, `type: 'opaqueredirect'`, empty headers/body) for a
 * manual-mode cross-origin redirect *regardless of whether the extension
 * holds host permission for that origin* -- confirmed against a real
 * DOI -> IEEE Xplore redirect, where even the very first hop (doi.org, an
 * already-permitted origin) still came back opaque. There is no real
 * status or Location to read from that response, so per-hop inspection
 * doesn't work here; the browser has to be the one following the chain.
 *
 * The starting URL and the final response's URL are still checked with
 * `isSafePublisherUrl` (HTTPS only, no local/private network targets, no
 * embedded credentials). That's weaker than per-hop validation -- Chrome's
 * own network stack decides which intermediate hops to follow, not this
 * code -- but it's what the platform actually allows for a request that
 * needs to work across origins the way DOI resolution requires.
 */
export async function safeRedirectFetch(
  startUrl: string,
  options: RedirectFetchOptions = {},
): Promise<RedirectFetchResult> {
  if (!isSafePublisherUrl(startUrl)) {
    throw new Error(`Refusing to fetch an unsafe URL: ${startUrl}`)
  }

  const response = await fetch(startUrl, {
    ...options.init,
    credentials: 'include',
    redirect: 'follow',
  })

  const finalUrl = response.url || startUrl
  if (!isSafePublisherUrl(finalUrl)) {
    throw new Error(`Refusing to trust a response from an unsafe URL: ${finalUrl}`)
  }

  return { response, finalUrl, redirected: response.redirected }
}
