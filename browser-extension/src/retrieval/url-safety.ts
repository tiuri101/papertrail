// Publisher URLs originate from publication metadata (DOI/publisher_url) or
// from links discovered inside publisher-served HTML -- both are untrusted
// input as far as this extension is concerned. Every URL is validated here
// before it is ever fetched.
//
// Caveat: this only inspects the hostname/literal-IP text of the URL, not
// the IP address it resolves to. A hostname that resolves to a private/
// loopback address only at fetch time (DNS rebinding) is not caught -- there
// is no extension API to inspect the resolved address before fetch() runs.
// This is a best-effort client-side check, not a substitute for the backend
// re-validating any uploaded content on its own terms.

function isPrivateOrLoopbackIPv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) return false
  const first = Number(match[1])
  const second = Number(match[2])
  if ([first, second].some((part) => Number.isNaN(part) || part < 0 || part > 255)) return false
  if (first === 127) return true // loopback (127.0.0.0/8)
  if (first === 10) return true // RFC1918
  if (first === 172 && second >= 16 && second <= 31) return true // RFC1918
  if (first === 192 && second === 168) return true // RFC1918
  if (first === 169 && second === 254) return true // link-local
  if (first === 0) return true
  return false
}

function isPrivateOrLoopbackIPv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === '::1' || normalized === '::') return true
  if (normalized.startsWith('fe80:')) return true // link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true // unique local
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or its hex form ::ffff:7f00:1):
  // the URL parser can serialize either form, so the embedded IPv4 address
  // needs the same check the plain-IPv4 path above does, or it bypasses it.
  const mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized)
  const dottedGroup = mappedDotted?.[1]
  if (dottedGroup) return isPrivateOrLoopbackIPv4(dottedGroup)
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized)
  if (mappedHex?.[1] && mappedHex[2]) {
    const high = Number.parseInt(mappedHex[1], 16)
    const low = Number.parseInt(mappedHex[2], 16)
    const dotted = [
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 8) & 0xff,
      low & 0xff,
    ].join('.')
    return isPrivateOrLoopbackIPv4(dotted)
  }
  return false
}

function isLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return lower === 'localhost' || lower.endsWith('.localhost')
}

/** A URL a publisher (or a redirect / discovered link on a publisher page)
 * may point retrieval at. Deliberately strict: HTTPS only, no embedded
 * credentials, no local/private network targets. */
export function isSafePublisherUrl(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const hostname = url.hostname
  if (!hostname) return false
  if (isLocalHostname(hostname)) return false
  if (isPrivateOrLoopbackIPv4(hostname)) return false
  if (isPrivateOrLoopbackIPv6(hostname)) return false
  return true
}

/** The configured Papertrail server URL follows separate, more permissive
 * rules: HTTPS is required in general, but plain HTTP is allowed for local
 * development (localhost/127.0.0.1). This must never be applied to
 * publisher URLs. */
export function isSafePapertrailServerUrl(candidate: string): boolean {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') {
    const hostname = url.hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')
  }
  return false
}
