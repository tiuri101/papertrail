import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'

import { MOBILE_MENU_SECTION_SLOT_ID, useCloseMobileMenu } from './mobileMenu'

const HEADER_SECTION_NAV_SLOT_ID = 'app-header-section-nav-slot'

export interface SectionNavigationItem {
  id: string
  label: string
}

export interface SectionNavigationContextValue {
  setSectionItems: (items: SectionNavigationItem[]) => void
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
      <ul className="mt-3 grid list-none gap-1 p-0">
        {items.map((item) => (
          <li key={item.id}>
            <a
              className="block rounded-sm px-3 py-[9px] text-sm font-semibold text-text-secondary no-underline hover:bg-surface-hover hover:text-primary hover:no-underline"
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
    <Link className="inline-flex min-h-10 min-w-0 max-w-[34vw] items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-sm px-2 text-[0.86rem] font-semibold text-text-secondary no-underline hover:bg-surface-hover hover:text-text hover:no-underline min-[761px]:max-w-[420px] min-[761px]:px-3 min-[761px]:text-[0.92rem]" to={backTo}>
      ← {backLabel}
    </Link>
  ) : null

  const mobileMenuSections = items.length > 0 ? (
    <div className="mt-5 border-t border-border pt-5">
      <p className="m-0 text-xs font-bold uppercase tracking-[0.1em] text-text-muted">{label}</p>
      <MenuLinks items={items} onNavigate={navigateTo} />
    </div>
  ) : null

  return (
    <div className="relative">
      <aside className="absolute left-[calc(50%_-_834px)] top-10 hidden h-[calc(100%_-_3rem)] w-[220px] min-[1700px]:block">
        <div className="sticky top-[92px] border-l border-border pl-4">
          {backTo ? (
            <Link className="mb-4 inline-flex min-h-9 items-center rounded-sm px-3 font-semibold text-text-secondary no-underline hover:bg-surface-hover hover:text-text hover:no-underline" to={backTo}>
              ← {backLabel}
            </Link>
          ) : null}
          {items.length > 0 ? (
            <>
              <p className="m-0 text-xs font-bold uppercase tracking-[0.1em] text-text-muted">{label}</p>
              <MenuLinks items={items} onNavigate={navigateTo} />
            </>
          ) : null}
        </div>
      </aside>

      {headerBackLink
        ? (headerSlot
            ? createPortal(<div className="flex min-w-0 items-center gap-2 min-[1700px]:hidden" data-testid="section-navigation-header-controls">{headerBackLink}</div>, headerSlot)
            : <div className="flex min-w-0 items-center gap-2 min-[1700px]:hidden" data-testid="section-navigation-header-controls">{headerBackLink}</div>)
        : null}

      {mobileMenuSections
        ? (mobileMenuSlot ? createPortal(mobileMenuSections, mobileMenuSlot) : mobileMenuSections)
        : null}

      {children}
    </div>
  )
}
