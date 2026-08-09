import { createContext, useContext } from 'react'

// The single mobile hamburger menu lives in AppShell. Pages nested deeper in the tree
// (e.g. SectionNavigationLayout) contribute content into it via this slot and context,
// instead of each rendering their own hamburger button and drawer.
export const MOBILE_MENU_SECTION_SLOT_ID = 'app-mobile-menu-section-slot'

interface MobileMenuContextValue {
  closeMobileMenu: () => void
}

export const MobileMenuContext = createContext<MobileMenuContextValue | null>(null)

export function useCloseMobileMenu() {
  const context = useContext(MobileMenuContext)
  return context?.closeMobileMenu ?? (() => {})
}
