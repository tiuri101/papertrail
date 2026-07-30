import { getCsrfToken } from '../features/auth/session'

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const csrf = getCsrfToken()
  const headers = new Headers(init.headers)
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (csrf) headers.set('X-CSRF-Token', csrf)
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new ApiError(
      response.status,
      body?.error?.message ?? response.statusText,
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return apiRequest<T>(`/api/v1${path}`, init)
}
