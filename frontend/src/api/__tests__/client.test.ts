import { describe, expect, it } from 'vitest'

import { ApiError, api, apiRequest } from '../client'
import { setCsrfToken } from '../../features/auth/session'
import { emptyResponse, jsonResponse, mockFetch } from '../../test/http'

describe('apiRequest', () => {
  it('sends credentials, JSON content type, and the current CSRF token', async () => {
    setCsrfToken('csrf-123')
    const fetchMock = mockFetch(() => jsonResponse({ ok: true }))

    await apiRequest('/api/v1/example', {
      method: 'POST',
      body: JSON.stringify({ value: 42 }),
    })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe('/api/v1/example')
    expect(init?.credentials).toBe('include')
    const headers = new Headers(init?.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-123')
  })

  it('does not set a JSON content type for FormData uploads', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ jobId: 'job-1' }))
    const body = new FormData()
    body.append('file', new File(['title'], 'records.csv', { type: 'text/csv' }))

    await apiRequest('/api/v1/imports', { method: 'POST', body })

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.has('Content-Type')).toBe(false)
  })

  it('returns undefined for a successful response without content', async () => {
    mockFetch(() => emptyResponse())
    await expect(apiRequest<void>('/api/v1/logout', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('raises an ApiError using the API error message', async () => {
    mockFetch(() => jsonResponse({ error: { message: 'Invalid credentials' } }, 401, 'Unauthorized'))

    await expect(apiRequest('/api/v1/login')).rejects.toEqual(
      expect.objectContaining({ status: 401, message: 'Invalid credentials' }),
    )
  })

  it('prefixes application API paths', async () => {
    const fetchMock = mockFetch(() => jsonResponse([]))
    await api('/projects')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/projects')
  })
})
