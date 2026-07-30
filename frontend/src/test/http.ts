import { vi } from 'vitest'

export function jsonResponse(body: unknown, status = 200, statusText = '') {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function emptyResponse(status = 204) {
  return new Response(null, { status })
}

export function mockFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
) {
  const fetchMock = vi.fn(implementation)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
