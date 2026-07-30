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
  const routedUi = path
    ? <Routes><Route path={path} element={ui} /></Routes>
    : ui

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[route]}>{routedUi}</MemoryRouter>
      </QueryClientProvider>,
    ),
  }
}
