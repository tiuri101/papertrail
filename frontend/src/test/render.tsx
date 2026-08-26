import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  })
}

interface RenderOptions {
  route?: string
  path?: string
  queryClient?: QueryClient
}

export function renderWithProviders(
  ui: ReactElement,
  { route = '/', path, queryClient = createTestQueryClient() }: RenderOptions = {},
) {
  const wrap = (element: ReactElement) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        {path ? <Routes><Route path={path} element={element} /></Routes> : element}
      </MemoryRouter>
    </QueryClientProvider>
  )

  const result = render(wrap(ui))

  return {
    queryClient,
    ...result,
    // Testing Library's own `rerender` renders the bare element, dropping the
    // providers. Tests that change a prop mid-mount (to check a component
    // reinitializes when it's pointed at a different project, say) need the
    // same wrapper, or the component loses its QueryClient.
    rerender: (next: ReactElement) => result.rerender(wrap(next)),
  }
}
