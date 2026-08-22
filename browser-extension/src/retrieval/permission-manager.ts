/**
 * A single, broad grant covering every HTTPS publisher site, rather than
 * asking for one narrow origin (e.g. `https://link.springer.com/*`) at a
 * time. Retrieval routinely has to follow a DOI to whatever origin the
 * publisher actually serves from -- that target is opaque to this code
 * until the browser has already followed the redirect (see
 * redirect-fetch.ts), so there's no way to know which specific origin to
 * request permission for in advance. Narrower per-origin prompting was
 * tried and doesn't work here: it either re-prompts for every publication
 * or deadlocks with a CORS error on the very first cross-origin redirect.
 */
export const PUBLISHER_ACCESS_ORIGIN = 'https://*/*'

export async function hasPublisherAccess(): Promise<boolean> {
  return hasOriginPermission(PUBLISHER_ACCESS_ORIGIN)
}

/** The exact origin pattern (e.g. `https://link.springer.com/*`) Chrome's
 * runtime host-permissions API expects for a given URL. Still used to check
 * permission for a specific *discovered* PDF candidate URL, which may live
 * on a different (also-https) origin than the landing page. */
export function originPattern(url: string): string {
  const parsed = new URL(url)
  return `${parsed.protocol}//${parsed.hostname}/*`
}

export async function hasOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [origin] })
}

/** Must be called from a user gesture (e.g. a button click) -- Chrome
 * rejects `permissions.request` otherwise. */
export async function requestOriginPermission(origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [origin] })
}
