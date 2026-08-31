export type TabPdfCaptureOutcome =
  | { ok: true; base64: string; contentType: string; finalUrl: string }
  | { ok: false }

/**
 * Runs inside the already-open, already-rendered publisher tab (via
 * `chrome.scripting.executeScript`'s `func` option), not in the extension's
 * background context. Some publishers sit behind a check that a plain
 * background `fetch()` never gets past, no matter what cookies it carries --
 * but a `fetch()` issued from inside the tab itself carries the exact same
 * request fingerprint as the page the user is already looking at, so it
 * isn't stopped the same way. This also means it can see the live, post-JS
 * DOM (e.g. a "Download PDF" link that only exists inside a dropdown menu),
 * not just the static HTML a background fetch of the same URL would
 * receive.
 *
 * Must stay entirely self-contained -- `chrome.scripting.executeScript`
 * transfers this function into a different JS world, so it cannot close
 * over anything from the module it's defined in (no imports, no outer
 * variables). Only `document`, `fetch`, and other page-context globals are
 * available at the point it actually runs.
 *
 * Some publishers put a client-side redirect (a `<meta http-equiv=refresh>`
 * or a one-line `location = ...` script) between a PDF's URL and the actual
 * file -- invisible to `fetch()` either way since it never executes scripts
 * or honors meta-refresh. Each candidate follows a bounded chain of these,
 * including honoring a delayed refresh, before giving up.
 */
export async function captureCandidatePdfFromTab(
  landingUrl: string,
  maxBytes: number,
): Promise<TabPdfCaptureOutcome> {
  function resolveHref(href: string | null | undefined, base: string): string | null {
    if (!href) return null
    try {
      return new URL(href, base).toString()
    } catch {
      return null
    }
  }

  /** Some publishers' meta-refresh nests a single-quoted URL inside the
   * double-quoted `content` attribute (`content="5; URL='/path'"`) -- a
   * naive "stop at any quote" pattern can't see past that inner quote, so
   * the outer content value is captured first (matching whichever quote
   * character actually opens it, via backreference) and the delay/URL are
   * parsed out of that captured string separately. */
  function extractClientRedirectTarget(html: string, base: string): { target: string; delayMs: number } | null {
    const metaMatch = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=(["'])((?:(?!\1)[\s\S])*)\1/i.exec(html)
    const contentValue = metaMatch?.[2]
    if (contentValue) {
      const urlMatch = /url\s*=\s*['"]?([^'";]+)/i.exec(contentValue)
      const resolved = urlMatch?.[1] ? resolveHref(urlMatch[1], base) : null
      if (resolved) {
        const delayMatch = /^\s*(\d+(?:\.\d+)?)/.exec(contentValue)
        const delaySeconds = delayMatch?.[1] ? Math.min(Number.parseFloat(delayMatch[1]), 10) : 0
        return { target: resolved, delayMs: Math.max(delaySeconds, 0) * 1000 }
      }
    }

    const jsRedirect = /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']|\blocation\.replace\(\s*["']([^"']+)["']\s*\)/i.exec(html)
    const target = jsRedirect?.[1] ?? jsRedirect?.[2]
    const resolved = target ? resolveHref(target, base) : null
    return resolved ? { target: resolved, delayMs: 0 } : null
  }

  const PDF_HREF_PATTERN = /\.pdf(\?|#|$)/i
  const DOWNLOAD_TEXT_PATTERN = /download pdf|view pdf|full text pdf|pdf full text|get pdf/i

  const candidates: string[] = []

  const citationMeta = document.querySelector('meta[name="citation_pdf_url"]')
  const citationUrl = resolveHref(citationMeta?.getAttribute('content'), landingUrl)
  if (citationUrl) candidates.push(citationUrl)

  document.querySelectorAll('link[type="application/pdf"]').forEach((link) => {
    const resolved = resolveHref(link.getAttribute('href'), landingUrl)
    if (resolved) candidates.push(resolved)
  })

  document.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') ?? ''
    const text = (anchor.textContent ?? '').trim()
    if (PDF_HREF_PATTERN.test(href) || DOWNLOAD_TEXT_PATTERN.test(text)) {
      const resolved = resolveHref(href, landingUrl)
      if (resolved) candidates.push(resolved)
    }
  })

  // MDPI serves its PDF at the article path + "/pdf" (mirrors
  // src/resolvers/mdpi.ts) -- kept here too since MDPI's dropdown markup
  // doesn't reliably match the generic href/text patterns above.
  try {
    const url = new URL(landingUrl)
    if (url.hostname.endsWith('mdpi.com')) {
      const articlePath = url.pathname.replace(/\/+$/, '')
      if (articlePath && !/\/pdf$/i.test(articlePath)) {
        candidates.push(new URL(`${articlePath}/pdf`, url.origin).toString())
      }
    }
  } catch {
    // landingUrl wasn't a parseable absolute URL -- skip this fallback
  }

  const queue = [...new Set(candidates)]
  // A bound on total fetch attempts, not distinct URLs -- a "wait N seconds,
  // then retry this same URL" redirect is legitimately the same URL fetched
  // again, so uniqueness can't be what stops the loop here.
  const MAX_ATTEMPTS = 8
  let attempts = 0

  while (queue.length > 0 && attempts < MAX_ATTEMPTS) {
    const url = queue.shift()!
    attempts++

    try {
      const response = await fetch(url, { credentials: 'include' })
      if (!response.ok) continue

      const contentType = response.headers.get('Content-Type') ?? ''
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) continue

      const bytes = new Uint8Array(buffer)
      const head = String.fromCharCode(...bytes.subarray(0, Math.min(5, bytes.length)))
      if (head.startsWith('%PDF-')) {
        let binary = ''
        const chunkSize = 0x8000
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
        }
        return { ok: true, base64: btoa(binary), contentType, finalUrl: response.url || url }
      }

      if (contentType === '' || contentType.includes('html') || contentType.includes('text')) {
        const text = new TextDecoder('utf-8').decode(bytes)
        const redirect = extractClientRedirectTarget(text, response.url || url)
        if (redirect) {
          if (redirect.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, redirect.delayMs))
          }
          queue.push(redirect.target)
        }
      }
    } catch {
      // network error, CORS rejection, etc. -- try the next candidate
    }
  }
  return { ok: false }
}
