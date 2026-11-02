import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { AppShell } from '../AppShell'
import { SectionNavigationLayout } from '../../components/SectionNavigationLayout'
import { getCsrfToken, setCsrfToken } from '../../features/auth/session'
import type { LoginResponse } from '../../features/auth/types'
import { emptyResponse, jsonResponse, mockFetch } from '../../test/http'
import { createTestQueryClient, renderWithProviders } from '../../test/render'

function renderShell(session: LoginResponse) {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(['session'], session)
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<p>Dashboard</p>} />
      </Route>
      <Route path="/login" element={<p>Login page</p>} />
    </Routes>,
    { queryClient },
  )
}

const reviewerSession: LoginResponse = {
  user: { id: 'reviewer', username: 'reviewer', displayName: 'Reviewer', isAdmin: false, isActive: true },
  csrfToken: 'csrf',
}

// jsdom never lays anything out, so offsetWidth/clientWidth read 0 for every element —
// AppShell's header-collapse measurement (see `navExpanded` in AppShell.tsx) always sees
// "doesn't fit" as a result. To exercise the branch where the desktop nav actually fits,
// stub those two readonly properties per element via the `data-testid`s AppShell puts on
// the row, brand link, and hidden measurement probe.
async function withMockedHeaderWidths(
  widths: { row: number; brand: number; probe: number; backLink?: number },
  run: () => void | Promise<void>,
) {
  const widthFor = (element: Element): number => {
    switch (element.getAttribute('data-testid')) {
      case 'header-row':
        return widths.row
      case 'header-brand':
        return widths.brand
      // The real "← Project name" back link portaled into the header slot; AppShell
      // mirrors its width onto the `header-nav-probe-slot` placeholder inside the probe.
      case 'section-navigation-header-controls':
        return widths.backLink ?? 0
      case 'header-nav-probe': {
        const slotPlaceholder = element.querySelector<HTMLElement>('[data-testid="header-nav-probe-slot"]')
        const slotWidth = slotPlaceholder ? parseFloat(slotPlaceholder.style.width) || 0 : 0
        return widths.probe + slotWidth
      }
      default:
        return 0
    }
  }
  const descriptors = ['offsetWidth', 'clientWidth'].map((prop) => [
    prop,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop),
  ] as const)
  for (const [prop] of descriptors) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return widthFor(this)
      },
    })
  }
  try {
    // `run` may itself `await waitFor(...)` — the project-title back link mounts via a
    // portal one render after AppShell's own measurement effect first runs, and AppShell
    // only notices via a MutationObserver, whose callback fires asynchronously. Keep the
    // mocked widths in place for the whole of `run` so that settles correctly.
    await run()
  } finally {
    for (const [prop, descriptor] of descriptors) {
      // clientWidth isn't an own property of HTMLElement.prototype in jsdom (it's
      // inherited from Element.prototype), so there's nothing to restore it to — delete
      // the shadowing property we added instead, or it leaks into every later test.
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, prop, descriptor)
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
      }
    }
  }
}

describe('AppShell', () => {
  it('shows the desktop nav directly once it fits next to the brand block', async () => {
    await withMockedHeaderWidths({ row: 2000, brand: 100, probe: 400 }, () => {
      renderShell({
        ...reviewerSession,
        user: { ...reviewerSession.user, id: 'admin', username: 'admin', isAdmin: true },
      })
    })

    expect(screen.getByRole('button', { name: 'Sign Out' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users')
    expect(screen.getByRole('link', { name: 'Bookmarks' })).toHaveAttribute('href', '/bookmarks')
    expect(screen.queryByRole('button', { name: 'Main menu' })).not.toBeInTheDocument()
  })

  it('accounts for a portaled project title even though its width only exists once mounted', async () => {
    // Regression test: the project title back link is portaled into a `display: contents`
    // slot (see SectionNavigationLayout), which never has a measurable box of its own — an
    // earlier version of this measurement read the slot's own offsetWidth (always 0) and so
    // never noticed a long title, showing the full desktop nav even when it overflowed.
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(['session'], reviewerSession)

    await withMockedHeaderWidths({ row: 900, brand: 100, probe: 300, backLink: 700 }, async () => {
      renderWithProviders(
        <Routes>
          <Route element={<AppShell />}>
            <Route
              path="/projects/:id"
              element={
                <SectionNavigationLayout
                  items={[]}
                  backTo="/projects"
                  backLabel="Immersive Analytics for Urban Data in Virtual Reality Environments"
                >
                  <p>Project content</p>
                </SectionNavigationLayout>
              }
            />
          </Route>
        </Routes>,
        { queryClient, route: '/projects/42' },
      )

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Main menu' })).toBeInTheDocument()
      })
    })

    expect(screen.queryByRole('button', { name: 'Sign Out' })).not.toBeInTheDocument()
  })

  it('falls back to the hamburger menu once the desktop nav would overflow', async () => {
    await withMockedHeaderWidths({ row: 300, brand: 100, probe: 400 }, () => {
      renderShell(reviewerSession)
    })

    expect(screen.queryByRole('button', { name: 'Sign Out' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Main menu' })).toBeInTheDocument()
  })

  it('does not expose user administration to reviewers', () => {
    renderShell(reviewerSession)
    expect(screen.getByRole('link', { name: 'Projects' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Global Settings' })).not.toBeInTheDocument()
  })

  // The desktop nav (Help/Users/Global Settings links, Sign Out button) only mounts once
  // AppShell's ResizeObserver-based measurement confirms it fits next to the brand block —
  // see the `navExpanded` state in AppShell.tsx. jsdom never lays anything out for real
  // (every offsetWidth/clientWidth reads 0), so that measurement always resolves to "does
  // not fit" here, same as it would on a viewport too narrow for the full nav. These items
  // are still reachable through the hamburger menu, which is what these tests exercise.
  it('exposes Help to every signed-in user', () => {
    renderShell(reviewerSession)
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    expect(within(drawer).getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help')
  })

  it('exposes Bookmarks to every signed-in user from the mobile menu', () => {
    renderShell(reviewerSession)
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    expect(within(drawer).getByRole('link', { name: 'Bookmarks' })).toHaveAttribute('href', '/bookmarks')
  })

  it('shows user administration to the administrator', () => {
    renderShell({
      ...reviewerSession,
      user: { ...reviewerSession.user, id: 'admin', username: 'admin', isAdmin: true },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    expect(within(drawer).getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users')
    expect(within(drawer).getByRole('link', { name: 'Global Settings' })).toHaveAttribute('href', '/instance-settings')
  })

  it('logs out, clears client session state, and navigates to login', async () => {
    setCsrfToken('csrf')
    const fetchMock = mockFetch(() => emptyResponse())
    const { queryClient } = renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sign Out' }))

    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(queryClient.getQueryData(['session'])).toBeUndefined()
    expect(getCsrfToken()).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({ method: 'POST' }))
  })

  it('keeps the current screen and reports a logout failure', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Logout failed' } }, 500))
    renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sign Out' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Logout failed'))
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
  })

  it('exposes Account (and Users, for admins) from the mobile menu', () => {
    renderShell({
      ...reviewerSession,
      user: { ...reviewerSession.user, id: 'admin', username: 'admin', isAdmin: true },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    expect(within(drawer).getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users')
    expect(within(drawer).getByRole('link', { name: 'Global Settings' })).toHaveAttribute('href', '/instance-settings')
    expect(within(drawer).getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account')
    expect(within(drawer).getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help')
  })

  it('hides Users and Global Settings from the mobile menu for reviewers', () => {
    renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    expect(within(drawer).queryByRole('link', { name: 'Users' })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('link', { name: 'Global Settings' })).not.toBeInTheDocument()
    expect(within(drawer).getByRole('link', { name: 'Account' })).toBeInTheDocument()
  })

  it('signs out from the mobile menu', async () => {
    setCsrfToken('csrf')
    const fetchMock = mockFetch(() => emptyResponse())
    const { queryClient } = renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    const drawer = screen.getByRole('dialog', { name: 'Main menu' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sign Out' }))

    expect(await screen.findByText('Login page')).toBeInTheDocument()
    expect(queryClient.getQueryData(['session'])).toBeUndefined()
    expect(getCsrfToken()).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({ method: 'POST' }))
  })

  it('closes the mobile menu with Escape', () => {
    renderShell(reviewerSession)

    fireEvent.click(screen.getByRole('button', { name: 'Main menu' }))
    expect(screen.getByRole('dialog', { name: 'Main menu' })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Main menu' })).not.toBeInTheDocument()
  })
})
