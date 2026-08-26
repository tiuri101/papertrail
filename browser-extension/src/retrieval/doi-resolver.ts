import { fetchWithTimeout, MAX_JSON_BYTES, readTextWithLimit } from './response-limits'
import { isSafePublisherUrl } from './url-safety'

interface HandleValue {
  type: string
  data?: { value?: string }
}

interface HandleResponse {
  values?: HandleValue[]
}

// Resolves a DOI to its target publisher URL via the Handle System's own
// JSON API (doi.org/api/handles/<doi>) instead of fetching doi.org itself
// and letting the browser follow its redirect.
//
// That matters because a Chrome extension's host-permission CORS bypass
// only applies to the exact URL passed to fetch() -- not to wherever a
// redirect chain from that URL ends up (confirmed against a real DOI ->
// IEEE Xplore redirect: even with a granted wildcard-https permission, the
// browser still reports "blocked by CORS policy" for the redirected-to
// origin). The Handle API sidesteps this entirely: it's a plain JSON
// response (with a permissive, origin-reflecting Access-Control-Allow-
// Origin header) that hands back the target URL directly, so the actual
// publisher landing page can then be fetched as a single, non-redirected
// request -- which does get the normal CORS bypass.
export async function resolveDoiUrl(doi: string): Promise<string | null> {
  let response: Response
  try {
    response = await fetchWithTimeout(`https://doi.org/api/handles/${encodeURIComponent(doi)}`, {
      headers: { Accept: 'application/json' },
    })
  } catch {
    return null
  }
  if (!response.ok) return null

  let data: HandleResponse
  try {
    // Bounded read rather than response.json(): the Handle API's answer is a
    // few hundred bytes, and nothing about this response is under our
    // control, so it is read with the same size/stall limits as any other
    // remote body.
    data = JSON.parse(await readTextWithLimit(response, MAX_JSON_BYTES)) as HandleResponse
  } catch {
    return null
  }

  const urlValue = data.values?.find((value) => value.type === 'URL')?.data?.value
  if (!urlValue) return null

  const upgraded = urlValue.startsWith('http://') ? `https://${urlValue.slice('http://'.length)}` : urlValue
  return isSafePublisherUrl(upgraded) ? upgraded : null
}
