// Conservative, low-false-positive phrase list. A false NEEDS_AUTHENTICATION
// just costs the reviewer a manual look; a false negative would risk
// uploading a login/paywall page as if it were the paper, so the bar here
// stays deliberately narrow rather than clever.
const LOGIN_OR_PAYWALL_INDICATORS = [
  'sign in to continue',
  'log in to access',
  'institutional login',
  'shibboleth',
  'athens login',
  'please sign in',
  'please log in',
  'purchase this article',
  'buy this article',
  'get access to this article',
  'subscribe to view',
  'sign in via your institution',
  'access through your institution',
  'you do not have access',
]

export function looksLikeLoginOrPaywallPage(html: string): boolean {
  const lower = html.toLowerCase()
  return LOGIN_OR_PAYWALL_INDICATORS.some((indicator) => lower.includes(indicator))
}
