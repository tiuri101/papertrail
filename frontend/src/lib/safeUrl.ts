/**
 * Guards against `javascript:`/`data:`/etc. URIs being used as link targets.
 * User-supplied fields like publisherUrl are free text with no scheme
 * enforcement, so anything rendered as an href must be checked here first.
 */
export function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value, window.location.origin)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
