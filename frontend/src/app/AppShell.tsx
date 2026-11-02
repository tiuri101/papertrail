import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { apiRequest } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { Page } from '../components/Page'
import { DecorativeDocTrail } from '../components/DecorativeDocTrail'
import { IconBookmark, IconFolder, IconHelpCircle, IconPerson, IconSettings, IconUsers } from '../components/icons'
import { MOBILE_MENU_SECTION_SLOT_ID, MobileMenuContext } from '../components/mobileMenu'
import { ThemeToggle } from '../components/ThemeToggle'
import { cn } from '../lib/cn'
import { setCsrfToken } from '../features/auth/session'
import type { LoginResponse } from '../features/auth/types'

const navLinkBase =
  'inline-flex min-h-10 items-center gap-2 rounded-sm px-4 text-[0.92rem] font-semibold text-text-secondary hover:bg-surface-hover hover:text-text max-md:min-h-[38px] max-md:px-3 max-[480px]:px-2.5 max-[480px]:text-[0.86rem] [&>svg]:size-[17px] [&>svg]:shrink-0 [&>svg]:fill-current'
const navLinkActive = 'bg-primary-container text-primary'

// Pixels subtracted from the measured available width before comparing against the
// expanded nav's natural width, so we collapse a little before things actually touch —
// sub-pixel rounding, and a non-overlay scrollbar (~15-17px on Windows) that can appear
// after the initial measurement once a long list finishes loading.
const HEADER_OVERFLOW_SAFETY_PX = 20

// Rendered both in the real header (only while `isAdmin`) and in the hidden measurement
// probe below (always, so the probe reflects the widest case AppShell can render).
function CollapsibleNavLinks({ isAdmin }: { isAdmin: boolean }) {
  return (
    <>
      <NavLink to="/bookmarks" className={({ isActive }) => cn(navLinkBase, isActive && navLinkActive)}>
        <IconBookmark />
        Bookmarks
      </NavLink>
      {isAdmin ? (
        <NavLink to="/users" className={({ isActive }) => cn(navLinkBase, isActive && navLinkActive)}>
          <IconUsers />
          Users
        </NavLink>
      ) : null}
      {isAdmin ? (
        <NavLink
          to="/instance-settings"
          className={({ isActive }) => cn(navLinkBase, isActive && navLinkActive)}
        >
          <IconSettings />
          Global Settings
        </NavLink>
      ) : null}
      <NavLink to="/account" className={({ isActive }) => cn(navLinkBase, isActive && navLinkActive)}>
        <IconPerson />
        Account
      </NavLink>
      <NavLink to="/help" className={({ isActive }) => cn(navLinkBase, isActive && navLinkActive)}>
        <IconHelpCircle />
        Help
      </NavLink>
    </>
  )
}

export function AppShell() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = queryClient.getQueryData<LoginResponse>(['session'])
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mobileMenuId = useId()
  const isAdmin = Boolean(session?.user.isAdmin)
  const logout = useMutation({
    mutationFn: () => apiRequest<void>('/api/v1/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      setCsrfToken(null)
      queryClient.clear()
      navigate('/login')
    },
  })

  useEffect(() => {
    if (!mobileMenuOpen) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [mobileMenuOpen])

  // Whether the full desktop nav (all links + Sign Out) actually fits next to the brand
  // block at the header's current width, instead of guessing from a fixed viewport
  // breakpoint. `navProbeRef` is a hidden, always-fully-expanded mirror of the nav (see
  // below the header) whose natural width tells us what "expanded" would need; admins
  // and long project titles both change that need, so a fixed px breakpoint can't win for
  // everyone. Starts collapsed (the layout that always fits) so we never briefly paint an
  // overflowing header before the first measurement runs.
  const [navExpanded, setNavExpanded] = useState(false)
  const headerRowRef = useRef<HTMLDivElement>(null)
  const brandRef = useRef<HTMLAnchorElement>(null)
  const navProbeRef = useRef<HTMLDivElement>(null)
  const sectionSlotRef = useRef<HTMLDivElement>(null)
  const sectionSlotProbeRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const row = headerRowRef.current
    const brand = brandRef.current
    const probe = navProbeRef.current
    const slot = sectionSlotRef.current
    const slotProbe = sectionSlotProbeRef.current
    if (!row || !brand || !probe || !slot || !slotProbe) return undefined

    // `slot` itself is `display: contents` (so it never wastes gap space with nothing
    // portaled into it) and therefore never has a real box — offsetWidth on it always
    // reads 0 and ResizeObserver never fires on it. What we actually need to track is its
    // portaled child (the "← Project name" back link), which mounts later via a portal, so
    // we watch for that with a MutationObserver and (re-)subscribe a ResizeObserver to it.
    let observedSlotChild: Element | null = null

    const recompute = () => {
      const slotChild = slot.firstElementChild as HTMLElement | null
      if (slotChild !== observedSlotChild) {
        if (observedSlotChild) resizeObserver.unobserve(observedSlotChild)
        if (slotChild) resizeObserver.observe(slotChild)
        observedSlotChild = slotChild
      }
      // Mirror the slot child's width into the probe synchronously so the probe's total
      // reflects it immediately, without waiting on a React re-render.
      slotProbe.style.width = `${slotChild?.offsetWidth ?? 0}px`
      const rowGap = parseFloat(getComputedStyle(row).columnGap || '0') || 0
      const available = row.clientWidth - brand.offsetWidth - rowGap - HEADER_OVERFLOW_SAFETY_PX
      setNavExpanded(probe.offsetWidth <= available)
    }

    const resizeObserver = new ResizeObserver(recompute)
    resizeObserver.observe(row)
    resizeObserver.observe(brand)
    resizeObserver.observe(probe)

    const mutationObserver = new MutationObserver(recompute)
    mutationObserver.observe(slot, { childList: true })

    recompute()

    return () => {
      resizeObserver.disconnect()
      mutationObserver.disconnect()
    }
  }, [])

  return (
    <>
      <DecorativeDocTrail className="pointer-events-none fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-[max(1rem,env(safe-area-inset-left))] z-0 h-auto max-h-[calc(100vh-7rem)] w-[clamp(150px,14vw,210px)] max-w-[calc(100vw-2rem)] opacity-40 max-[900px]:hidden" />
      <header className="sticky top-0 z-50 border-b border-border bg-[color-mix(in_srgb,var(--color-bg)_84%,transparent)] backdrop-blur-[16px] backdrop-saturate-[1.4]">
        <div
          ref={headerRowRef}
          data-testid="header-row"
          className="mx-auto flex min-h-[68px] w-[min(1280px,calc(100%-2.5rem))] items-center justify-between gap-6 max-md:min-h-[62px] max-md:w-[min(1280px,calc(100%-1.5rem))] max-[480px]:gap-2"
        >
          <NavLink
            ref={brandRef}
            data-testid="header-brand"
            className="inline-flex items-center gap-3 text-[1.05rem] font-bold tracking-tight text-text hover:text-text hover:no-underline"
            to="/"
            aria-label="Papertrail home"
          >
            <span
              className="inline-grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-[linear-gradient(145deg,var(--color-primary),var(--color-primary-strong))] text-primary-contrast shadow-[0_7px_20px_var(--color-primary-container-hover)] max-[480px]:size-8"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" className="size-[21px] fill-current">
                <path d="M6 3h8.5L19 7.5V21H6V3Zm2 2v14h9V9h-4V5H8Zm7 1.4V7h.6L15 6.4Z" />
                <path d="M9.5 11h5v1.7h-5V11Zm0 3.4h5v1.7h-5v-1.7Z" />
              </svg>
            </span>
            <span className="max-md:hidden">Papertrail</span>
          </NavLink>
          <div className="flex items-center gap-2">
            <nav aria-label="Primary navigation" className="flex items-center gap-2">
              <NavLink
                to="/projects"
                className={({ isActive }) => cn(navLinkBase, isActive && navLinkActive)}
              >
                <IconFolder />
                Projects
              </NavLink>
              {navExpanded ? <CollapsibleNavLinks isAdmin={isAdmin} /> : null}
            </nav>
            {navExpanded ? <div className="mx-1 h-7 w-px bg-border" aria-hidden="true" /> : null}
            <ThemeToggle />
            {navExpanded ? (
              <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
                Sign Out
              </Button>
            ) : (
              <IconButton
                variant="secondary"
                aria-expanded={mobileMenuOpen}
                aria-controls={mobileMenuId}
                aria-label="Main menu"
                onClick={() => setMobileMenuOpen(true)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z" />
                </svg>
              </IconButton>
            )}
            <div id="app-header-section-nav-slot" ref={sectionSlotRef} data-testid="header-section-slot" className="contents" />
          </div>
        </div>
      </header>
      {/*
        Hidden mirror of the header's right-hand content, always rendered fully expanded
        (all nav links + divider + Sign Out), used only to measure whether that content
        would actually fit — see the useLayoutEffect above. `aria-hidden` + `visibility:
        hidden` keep it out of the accessibility tree and tab order, and `position: fixed`
        keeps it from affecting real layout or scroll size. `width: max-content` matters
        just as much as the visibility/position tricks: a `position: fixed` box with only
        `left` set otherwise shrink-to-fits against the *viewport* width, so once the probe's
        natural content is close to or past that width, its own nav links start wrapping
        (e.g. "Global Settings" onto two lines) and offsetWidth quietly reports that smaller,
        wrapped size instead of the true width we need to compare against.
      */}
      <div
        ref={navProbeRef}
        data-testid="header-nav-probe"
        aria-hidden="true"
        style={{
          visibility: 'hidden',
          position: 'fixed',
          top: 0,
          left: 0,
          width: 'max-content',
          pointerEvents: 'none',
        }}
        className="flex items-center gap-2"
      >
        <nav className="flex items-center gap-2">
          <NavLink to="/projects" className={navLinkBase}>
            <IconFolder />
            Projects
          </NavLink>
          <CollapsibleNavLinks isAdmin={isAdmin} />
        </nav>
        <div className="mx-1 h-7 w-px bg-border" />
        <ThemeToggle />
        <Button variant="secondary">Sign Out</Button>
        <div ref={sectionSlotProbeRef} data-testid="header-nav-probe-slot" />
      </div>
      <div
        className={cn('fixed inset-0 z-[100] bg-overlay', mobileMenuOpen && 'flex')}
        hidden={!mobileMenuOpen}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setMobileMenuOpen(false)
        }}
      >
        <aside
          id={mobileMenuId}
          className="h-full w-[min(320px,calc(100%-3rem))] overflow-y-auto border-r border-border bg-surface-raised p-5 shadow-lg"
          role="dialog"
          aria-modal="true"
          aria-label="Main menu"
        >
          <div className="mb-5 flex items-center justify-between gap-4">
            <h2 className="m-0">Menu</h2>
            <IconButton variant="secondary" aria-label="Close main menu" onClick={() => setMobileMenuOpen(false)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6.7 5.3 5.3 5.3 5.3-5.3 1.4 1.4-5.3 5.3 5.3 5.3-1.4 1.4-5.3-5.3-5.3 5.3-1.4-1.4 5.3-5.3-5.3-5.3 1.4-1.4Z" />
              </svg>
            </IconButton>
          </div>
          <nav className="grid gap-1">
            <NavLink to="/bookmarks" className={cn(navLinkBase, 'w-full justify-start')} onClick={() => setMobileMenuOpen(false)}>
              <IconBookmark />
              Bookmarks
            </NavLink>
            {isAdmin ? (
              <NavLink to="/users" className={cn(navLinkBase, 'w-full justify-start')} onClick={() => setMobileMenuOpen(false)}>
                <IconUsers />
                Users
              </NavLink>
            ) : null}
            {isAdmin ? (
              <NavLink
                to="/instance-settings"
                className={cn(navLinkBase, 'w-full justify-start')}
                onClick={() => setMobileMenuOpen(false)}
              >
                <IconSettings />
                Global Settings
              </NavLink>
            ) : null}
            <NavLink to="/account" className={cn(navLinkBase, 'w-full justify-start')} onClick={() => setMobileMenuOpen(false)}>
              <IconPerson />
              Account
            </NavLink>
            <NavLink to="/help" className={cn(navLinkBase, 'w-full justify-start')} onClick={() => setMobileMenuOpen(false)}>
              <IconHelpCircle />
              Help
            </NavLink>
          </nav>
          <div id={MOBILE_MENU_SECTION_SLOT_ID} />
          <div className="mt-5 border-t border-border pt-5">
            <Button variant="secondary" className="w-full" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Sign Out
            </Button>
          </div>
        </aside>
      </div>
      {logout.error ? <Page as="p" className="text-danger" role="alert">{logout.error.message}</Page> : null}
      <MobileMenuContext.Provider value={{ closeMobileMenu: () => setMobileMenuOpen(false) }}>
        <Outlet />
      </MobileMenuContext.Provider>
      <footer className="mt-auto border-t border-border py-5">
        <p className="mx-auto w-[min(1280px,calc(100%-2.5rem))] text-center text-sm text-text-muted">
          &copy; {new Date().getFullYear()} Georg Arbesser-Rastburg
          {` · v${import.meta.env.VITE_APP_VERSION ?? 'dev'}`}
        </p>
      </footer>
    </>
  )
}
