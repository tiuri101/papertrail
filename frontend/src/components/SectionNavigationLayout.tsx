import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useOutletContext } from 'react-router-dom'

import { MOBILE_MENU_SECTION_SLOT_ID, useCloseMobileMenu } from './mobileMenu'

const HEADER_SECTION_NAV_SLOT_ID = 'app-header-section-nav-slot'

export interface SectionNavigationItem {
  id: string
  label: string
}

export interface SectionNavigationContextValue {
  setSectionItems: (items: SectionNavigationItem[]) => void
}

// Lets a page nested inside a SectionNavigationLayout's Outlet contribute its own "On this page" links.
export function useRegisterSectionItems(items: SectionNavigationItem[]) {
  const context = useOutletContext<SectionNavigationContextValue | null>()
  useEffect(() => {
    context?.setSectionItems(items)
    return () => context?.setSectionItems([])
  }, [context, items])
}

interface SectionNavigationLayoutProps {
  items: SectionNavigationItem[]
  children: ReactNode
  label?: string
  backTo?: string
  backLabel?: string
}

function MenuLinks({
  items,
  onNavigate,
}: {
  items: SectionNavigationItem[]
  onNavigate: (id: string) => void
}) {
  return (
    <nav aria-label="Page sections">
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              onClick={(event) => {
                event.preventDefault()
                onNavigate(item.id)
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function SectionNavigationLayout({
  items,
  children,
  label = 'On this page',
  backTo,
  backLabel = 'Back to Project',
}: SectionNavigationLayoutProps) {
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  const [mobileMenuSlot, setMobileMenuSlot] = useState<HTMLElement | null>(null)
  const closeMobileMenu = useCloseMobileMenu()

  useLayoutEffect(() => {
    setHeaderSlot(document.getElementById(HEADER_SECTION_NAV_SLOT_ID))
    setMobileMenuSlot(document.getElementById(MOBILE_MENU_SECTION_SLOT_ID))
  }, [])

  const navigateTo = (id: string) => {
    const target = document.getElementById(id)
    if (!target) return
    const collapsedToggle = target.querySelector<HTMLButtonElement>(
      '.collapsible-section__toggle[aria-expanded="false"]',
    )
    collapsedToggle?.click()
    window.history.replaceState(null, '', `#${id}`)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    closeMobileMenu()
  }

  const headerBackLink = backTo ? (
    <Link className="section-navigation__header-back-link" to={backTo}>
      ← {backLabel}
    </Link>
  ) : null

  const mobileMenuSections = items.length > 0 ? (
    <div className="mobile-drawer__section-links section-navigation">
      <p className="section-navigation__label">{label}</p>
      <MenuLinks items={items} onNavigate={navigateTo} />
    </div>
  ) : null

  return (
    <div className="section-navigation-layout">
      <aside className="section-navigation section-navigation--desktop">
        <div className="section-navigation__panel">
          {backTo ? (
            <Link className="section-navigation__back-link" to={backTo}>
              ← {backLabel}
            </Link>
          ) : null}
          {items.length > 0 ? (
            <>
              <p className="section-navigation__label">{label}</p>
              <MenuLinks items={items} onNavigate={navigateTo} />
            </>
          ) : null}
        </div>
      </aside>

      {headerBackLink
        ? (headerSlot
            ? createPortal(<div className="section-navigation__mobile-bar">{headerBackLink}</div>, headerSlot)
            : <div className="section-navigation__mobile-bar">{headerBackLink}</div>)
        : null}

      {mobileMenuSections
        ? (mobileMenuSlot ? createPortal(mobileMenuSections, mobileMenuSlot) : mobileMenuSections)
        : null}

      {children}
    </div>
  )
}
