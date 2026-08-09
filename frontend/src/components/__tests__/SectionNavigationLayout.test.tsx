import { fireEvent, screen, within } from '@testing-library/react'
import { type ReactNode, useState } from 'react'
import { Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CollapsibleSection } from '../CollapsibleSection'
import { MOBILE_MENU_SECTION_SLOT_ID, MobileMenuContext } from '../mobileMenu'
import {
  type SectionNavigationItem,
  SectionNavigationLayout,
  useRegisterSectionItems,
} from '../SectionNavigationLayout'
import { renderWithProviders } from '../../test/render'

const HEADER_SECTION_NAV_SLOT_ID = 'app-header-section-nav-slot'

// Simulates the slots + context that AppShell provides in production, so the single
// merged mobile menu (owned by AppShell) can be exercised without rendering AppShell itself.
// The provider must wrap the routed content too, not just the slots, since that's where
// SectionNavigationLayout (the context consumer) actually renders.
function AppShellSlots({
  onCloseMobileMenu = () => {},
  children,
}: {
  onCloseMobileMenu?: () => void
  children: ReactNode
}) {
  return (
    <MobileMenuContext.Provider value={{ closeMobileMenu: onCloseMobileMenu }}>
      <div id={HEADER_SECTION_NAV_SLOT_ID} />
      <div id={MOBILE_MENU_SECTION_SLOT_ID} data-testid="mobile-menu-section-slot" />
      {children}
    </MobileMenuContext.Provider>
  )
}

describe('SectionNavigationLayout', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('expands the selected section when a page-section link is activated', () => {
    const { container } = renderWithProviders(
      <SectionNavigationLayout
        items={[{ id: 'section-details', label: 'Project Details' }]}
      >
        <CollapsibleSection
          id="section-details"
          title="Project Details"
          defaultExpanded={false}
        >
          <p>Section content</p>
        </CollapsibleSection>
      </SectionNavigationLayout>,
    )

    // Without AppShell's mobile-menu slot mounted, the section links render inline as a
    // fallback (see mobile-drawer__section-links); the desktop aside renders its own copy too.
    const fallbackLinks = container.querySelector('.mobile-drawer__section-links') as HTMLElement
    fireEvent.click(within(fallbackLinks).getByRole('link', { name: 'Project Details' }))

    expect(screen.getByRole('button', { name: 'Project Details' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('Section content')).toBeVisible()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('has no page-sections content when there are no section items', () => {
    renderWithProviders(
      <SectionNavigationLayout items={[]}>
        <main>Content</main>
      </SectionNavigationLayout>,
    )

    expect(screen.queryByRole('navigation', { name: 'Page sections' })).not.toBeInTheDocument()
  })

  function ProjectSectionLayout() {
    const [sectionItems, setSectionItems] = useState<SectionNavigationItem[]>([])
    return (
      <SectionNavigationLayout items={sectionItems} backTo="/projects/42">
        <Outlet context={{ setSectionItems }} />
      </SectionNavigationLayout>
    )
  }

  it('shows a back-to-project link directly in the header for a subpage with no sections of its own', () => {
    function JobsChildPage() {
      return <main>Jobs content</main>
    }

    const { container } = renderWithProviders(
      <Routes>
        <Route element={<ProjectSectionLayout />}>
          <Route path="/projects/:projectId/jobs" element={<JobsChildPage />} />
        </Route>
      </Routes>,
      { route: '/projects/42/jobs' },
    )

    const headerControls = container.querySelector('.section-navigation__mobile-bar') as HTMLElement
    expect(within(headerControls).getByRole('link', { name: '← Back to Project' })).toHaveAttribute(
      'href',
      '/projects/42',
    )
  })

  it('portals the back link and section links into the AppShell header and mobile menu slots when present', () => {
    // A stable reference matters here: useRegisterSectionItems's effect depends on this array,
    // and ProjectSectionLayout's Outlet context object is also recreated each render, so an
    // inline literal here would make the two chase each other into an infinite render loop.
    const memberSections: SectionNavigationItem[] = [{ id: 'section-members', label: 'Members' }]

    function AdminChildPage() {
      useRegisterSectionItems(memberSections)
      return (
        <main>
          <div id="section-members">Admin content</div>
        </main>
      )
    }

    const onCloseMobileMenu = vi.fn()

    renderWithProviders(
      <AppShellSlots onCloseMobileMenu={onCloseMobileMenu}>
        <Routes>
          <Route element={<ProjectSectionLayout />}>
            <Route path="/projects/:projectId/admin" element={<AdminChildPage />} />
          </Route>
        </Routes>
      </AppShellSlots>,
      { route: '/projects/42/admin' },
    )

    const headerSlot = document.getElementById(HEADER_SECTION_NAV_SLOT_ID) as HTMLElement
    expect(within(headerSlot).getByRole('link', { name: '← Back to Project' })).toHaveAttribute(
      'href',
      '/projects/42',
    )

    const sectionSlot = screen.getByTestId('mobile-menu-section-slot')
    const membersLink = within(sectionSlot).getByRole('link', { name: 'Members' })
    expect(membersLink).toBeInTheDocument()
    expect(within(sectionSlot).queryByRole('link', { name: '← Back to Project' })).not.toBeInTheDocument()

    fireEvent.click(membersLink)
    expect(onCloseMobileMenu).toHaveBeenCalled()
  })
})
