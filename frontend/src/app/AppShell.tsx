import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { apiRequest } from '../api/client'
import { IconFolder, IconPerson, IconUsers } from '../components/icons'
import { MOBILE_MENU_SECTION_SLOT_ID, MobileMenuContext } from '../components/mobileMenu'
import { ThemeToggle } from '../components/ThemeToggle'
import { setCsrfToken } from '../features/auth/session'
import type { LoginResponse } from '../features/auth/types'

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
      <header className="app-header">
        <div className="app-header__content">
          <NavLink className="brand" to="/" aria-label="Papertrail home">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 3h8.5L19 7.5V21H6V3Zm2 2v14h9V9h-4V5H8Zm7 1.4V7h.6L15 6.4Z" />
                <path d="M9.5 11h5v1.7h-5V11Zm0 3.4h5v1.7h-5v-1.7Z" />
              </svg>
            </span>
            <span>Papertrail</span>
          </NavLink>
          <div className="app-header__actions">
            <nav aria-label="Primary navigation">
              <NavLink to="/projects" className={({ isActive }) => isActive ? 'nav-link nav-link--active' : 'nav-link'}>
                <IconFolder />
                Projects
              </NavLink>
              {session?.user.isAdmin ? (
                <NavLink
                  to="/users"
                  className={({ isActive }) =>
                    isActive ? 'nav-link nav-link--active nav-link--collapsible' : 'nav-link nav-link--collapsible'
                  }
                >
                  <IconUsers />
                  Users
                </NavLink>
              ) : null}
              <NavLink
                to="/account"
                className={({ isActive }) =>
                  isActive ? 'nav-link nav-link--active nav-link--collapsible' : 'nav-link nav-link--collapsible'
                }
              >
                <IconPerson />
                Account
              </NavLink>
            </nav>
            <div className="header-divider" aria-hidden="true" />
            <ThemeToggle />
            <button
              className="button-secondary sign-out-button"
              type="button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              Sign Out
            </button>
            <button
              type="button"
              className="icon-button mobile-menu-button app-header__menu-button"
              aria-expanded={mobileMenuOpen}
              aria-controls={mobileMenuId}
              aria-label="Main menu"
              onClick={() => setMobileMenuOpen(true)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z" />
              </svg>
            </button>
            <div id="app-header-section-nav-slot" className="app-header__section-nav-slot" />
          </div>
        </div>
      </header>
      <div
        className="mobile-drawer-backdrop"
        hidden={!mobileMenuOpen}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setMobileMenuOpen(false)
        }}
      >
        <aside
          id={mobileMenuId}
          className="mobile-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="Main menu"
        >
          <div className="mobile-drawer__header">
            <h2>Menu</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close main menu"
              onClick={() => setMobileMenuOpen(false)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6.7 5.3 5.3 5.3 5.3-5.3 1.4 1.4-5.3 5.3 5.3 5.3-1.4 1.4-5.3-5.3-5.3 5.3-1.4-1.4 5.3-5.3-5.3-5.3 1.4-1.4Z" />
              </svg>
            </button>
          </div>
          <nav className="mobile-drawer__nav-links">
            {session?.user.isAdmin ? (
              <NavLink to="/users" className="nav-link" onClick={() => setMobileMenuOpen(false)}>
                <IconUsers />
                Users
              </NavLink>
            ) : null}
            <NavLink to="/account" className="nav-link" onClick={() => setMobileMenuOpen(false)}>
              <IconPerson />
              Account
            </NavLink>
          </nav>
          <div id={MOBILE_MENU_SECTION_SLOT_ID} className="mobile-drawer__section-slot" />
          <div className="mobile-drawer__footer">
            <button
              type="button"
              className="button-secondary mobile-drawer__sign-out-button"
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              Sign Out
            </button>
          </div>
        </aside>
      </div>
      {logout.error ? <p className="page error" role="alert">{logout.error.message}</p> : null}
      <MobileMenuContext.Provider value={{ closeMobileMenu: () => setMobileMenuOpen(false) }}>
        <Outlet />
      </MobileMenuContext.Provider>
    </>
  )
}
