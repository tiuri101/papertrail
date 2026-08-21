import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { apiRequest } from '../api/client'
import { Button, IconButton } from '../components/Button'
import { DecorativeDocTrail } from '../components/DecorativeDocTrail'
import { IconFolder, IconHelpCircle, IconPerson, IconSettings, IconUsers } from '../components/icons'
import { MOBILE_MENU_SECTION_SLOT_ID, MobileMenuContext } from '../components/mobileMenu'
import { ThemeToggle } from '../components/ThemeToggle'
import { cn } from '../lib/cn'
import { setCsrfToken } from '../features/auth/session'
import type { LoginResponse } from '../features/auth/types'

const navLinkBase =
  'inline-flex min-h-10 items-center gap-2 rounded-sm px-4 text-[0.92rem] font-semibold text-text-secondary hover:bg-surface-hover hover:text-text [&>svg]:size-[17px] [&>svg]:shrink-0 [&>svg]:fill-current'
const navLinkActive = 'bg-primary-container text-primary'
const navLinkCollapsible = 'max-md:hidden'

export function AppShell() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = queryClient.getQueryData<LoginResponse>(['session'])
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mobileMenuId = useId()
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

  return (
    <>
      <DecorativeDocTrail className="app-background-illustration" />
      <header className="sticky top-0 z-50 border-b border-border bg-[color-mix(in_srgb,var(--color-bg)_84%,transparent)] backdrop-blur-[16px] backdrop-saturate-[1.4]">
        <div className="mx-auto flex min-h-[68px] w-[min(1280px,calc(100%-2.5rem))] items-center justify-between gap-6">
          <NavLink
            className="inline-flex items-center gap-3 text-[1.05rem] font-bold tracking-tight text-text hover:text-text hover:no-underline"
            to="/"
            aria-label="Papertrail home"
          >
            <span
              className="inline-grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-[linear-gradient(145deg,var(--color-primary),var(--color-primary-strong))] text-primary-contrast shadow-[0_7px_20px_var(--color-primary-container-hover)]"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" className="size-[21px] fill-current">
                <path d="M6 3h8.5L19 7.5V21H6V3Zm2 2v14h9V9h-4V5H8Zm7 1.4V7h.6L15 6.4Z" />
                <path d="M9.5 11h5v1.7h-5V11Zm0 3.4h5v1.7h-5v-1.7Z" />
              </svg>
            </span>
            <span>Papertrail</span>
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
              {session?.user.isAdmin ? (
                <NavLink
                  to="/users"
                  className={({ isActive }) => cn(navLinkBase, navLinkCollapsible, isActive && navLinkActive)}
                >
                  <IconUsers />
                  Users
                </NavLink>
              ) : null}
              {session?.user.isAdmin ? (
                <NavLink
                  to="/instance-settings"
                  className={({ isActive }) => cn(navLinkBase, navLinkCollapsible, isActive && navLinkActive)}
                >
                  <IconSettings />
                  Global Settings
                </NavLink>
              ) : null}
              <NavLink
                to="/account"
                className={({ isActive }) => cn(navLinkBase, navLinkCollapsible, isActive && navLinkActive)}
              >
                <IconPerson />
                Account
              </NavLink>
              <NavLink
                to="/help"
                className={({ isActive }) => cn(navLinkBase, navLinkCollapsible, isActive && navLinkActive)}
              >
                <IconHelpCircle />
                Help
              </NavLink>
            </nav>
            <div className="mx-1 h-7 w-px bg-border" aria-hidden="true" />
            <ThemeToggle />
            <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Sign Out
            </Button>
            <IconButton
              variant="secondary"
              // `!` is needed here: Button's own base class always includes `inline-flex`,
              // and Tailwind v4 doesn't resolve two same-property utilities by className
              // order, so a plain `hidden` never wins against it at any viewport width.
              className="hidden! max-md:inline-flex!"
              aria-expanded={mobileMenuOpen}
              aria-controls={mobileMenuId}
              aria-label="Main menu"
              onClick={() => setMobileMenuOpen(true)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z" />
              </svg>
            </IconButton>
            <div id="app-header-section-nav-slot" className="contents" />
          </div>
        </div>
      </header>
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
            {session?.user.isAdmin ? (
              <NavLink to="/users" className={cn(navLinkBase, 'w-full justify-start')} onClick={() => setMobileMenuOpen(false)}>
                <IconUsers />
                Users
              </NavLink>
            ) : null}
            {session?.user.isAdmin ? (
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
          <div id={MOBILE_MENU_SECTION_SLOT_ID} className="mobile-drawer__section-slot" />
          <div className="mt-5 border-t border-border pt-5">
            <Button variant="secondary" className="w-full" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Sign Out
            </Button>
          </div>
        </aside>
      </div>
      {logout.error ? <p className="page error" role="alert">{logout.error.message}</p> : null}
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
