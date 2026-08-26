import { getCsrfToken } from '../features/auth/session'

// The backend's error envelope is `{"error": {code, message, details?}}` (see
// backend/app/api/errors.py). `code` and `details` are the machine-readable
// half of it: several domain errors -- a locked structural setting, a
// lifecycle operation blocked by running jobs -- are only actionable if the
// client can branch on them rather than print `message` and stop. Dropping
// them at the transport boundary, as this client used to, made every such
// error indistinguishable from a generic failure.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null = null,
    public details: Record<string, unknown> | null = null,
  ) {
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
    const error = body?.error
    throw new ApiError(
      response.status,
      error?.message ?? response.statusText,
      typeof error?.code === 'string' ? error.code : null,
      error?.details && typeof error.details === 'object' ? error.details : null,
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return apiRequest<T>(`/api/v1${path}`, init)
}
