import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/**
 * Scrolls to the top of the page on every route change, except when the navigation targets a
 * specific element on the destination page (a URL hash) — those are left to that page's own
 * scroll-into-view handling (see e.g. PublicationsPage's #metadata-conflicts effect).
 */
export function ScrollToTop() {
  const { pathname, hash } = useLocation()

  useEffect(() => {
    if (hash) return
    window.scrollTo(0, 0)
  }, [pathname, hash])

  return null
}
