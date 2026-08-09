import { useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'

import type { SectionNavigationContextValue, SectionNavigationItem } from './SectionNavigationLayout'

// Lets a page nested inside a SectionNavigationLayout's Outlet contribute its own "On this page" links.
export function useRegisterSectionItems(items: SectionNavigationItem[]) {
  const context = useOutletContext<SectionNavigationContextValue | null>()
  useEffect(() => {
    context?.setSectionItems(items)
    return () => context?.setSectionItems([])
  }, [context, items])
}
