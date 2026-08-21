import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BrowserHelpersSection } from '../BrowserHelpersSection'
import { jsonResponse, mockFetch } from '../../../test/http'
import { renderWithProviders } from '../../../test/render'

const agent = {
  id: 'agent-1',
  displayName: 'Chrome on Desktop',
  extensionVersion: '1.2.0',
  createdAt: '2026-08-01T10:00:00Z',
  lastSeenAt: '2026-08-15T09:00:00Z',
  revokedAt: null,
}

function render({
  agents = [] as unknown[],
  pairingSecretResponse = {
    pairingSecret: 'secret-value-12345',
    expiresAt: '2026-08-15T10:10:00Z',
    serverUrl: 'https://papertrail.example.org',
  },
  revokeStatus = 204,
}: {
  agents?: unknown[]
  pairingSecretResponse?: unknown
  revokeStatus?: number
} = {}) {
  const fetchMock = mockFetch((input, init) => {
    const path = String(input)
    if (path.endsWith('/browser-agents') && (!init || init.method === undefined)) {
      return jsonResponse(agents)
    }
    if (path.endsWith('/browser-agents/pairing-secrets') && init?.method === 'POST') {
      return jsonResponse(pairingSecretResponse)
    }
    if (/\/browser-agents\/[^/]+$/.test(path) && init?.method === 'DELETE') {
      return revokeStatus === 204
        ? new Response(null, { status: 204 })
        : jsonResponse({ error: { code: 'not_found', message: 'Browser helper not found' } }, revokeStatus)
    }
    return jsonResponse({})
  })
  renderWithProviders(<BrowserHelpersSection />)
  return fetchMock
}

describe('BrowserHelpersSection', () => {
  it('lists paired browser helpers', async () => {
    render({ agents: [agent] })

    expect(await screen.findByText('Chrome on Desktop')).toBeInTheDocument()
    expect(screen.getByText(/Extension v1.2.0/)).toBeInTheDocument()
  })

  it('shows a message when no browser helper is paired', async () => {
    render({ agents: [] })

    expect(await screen.findByText('No browser helper is paired with your account.')).toBeInTheDocument()
  })

  it('creates a pairing secret and shows it once with a copy action', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    render({ agents: [] })

    fireEvent.click(await screen.findByRole('button', { name: /Pair new browser helper/ }))

    expect(await screen.findByText('secret-value-12345')).toBeInTheDocument()
    expect(screen.getByText('https://papertrail.example.org')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('secret-value-12345'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText('secret-value-12345')).not.toBeInTheDocument()
  })

  it('revokes a browser helper', async () => {
    const fetchMock = render({ agents: [agent] })

    await screen.findByText('Chrome on Desktop')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() => {
      const revokeCall = fetchMock.mock.calls.find(
        ([input, init]) => String(input).endsWith('/browser-agents/agent-1') && init?.method === 'DELETE',
      )
      expect(revokeCall).toBeDefined()
    })
  })

  it('polls and lists a newly paired browser helper without a page refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let agents: unknown[] = []
      const fetchMock = mockFetch((input, init) => {
        const path = String(input)
        if (path.endsWith('/browser-agents') && (!init || init.method === undefined)) {
          return jsonResponse(agents)
        }
        if (path.endsWith('/browser-agents/pairing-secrets') && init?.method === 'POST') {
          return jsonResponse({
            pairingSecret: 'secret-value-12345',
            expiresAt: '2026-08-15T10:10:00Z',
            serverUrl: 'https://papertrail.example.org',
          })
        }
        return jsonResponse({})
      })
      renderWithProviders(<BrowserHelpersSection />)

      fireEvent.click(await screen.findByRole('button', { name: /Pair new browser helper/ }))
      await screen.findByText('secret-value-12345')

      // The extension pairs directly against the backend, outside this tab.
      agents = [agent]
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })

      await waitFor(() => expect(fetchMock.mock.calls.filter(
        ([input, init]) => String(input).endsWith('/browser-agents') && (!init || init.method === undefined),
      ).length).toBeGreaterThan(1))
      expect(await screen.findByText('Chrome on Desktop')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows an API error when creating a pairing secret fails', async () => {
    const fetchMock = mockFetch(async (input, init) => {
      const path = String(input)
      if (path.endsWith('/browser-agents') && (!init || init.method === undefined)) return jsonResponse([])
      if (path.endsWith('/browser-agents/pairing-secrets') && init?.method === 'POST') {
        return jsonResponse({ error: { code: 'rate_limited', message: 'Too many pairing attempts' } }, 429)
      }
      return jsonResponse({})
    })
    renderWithProviders(<BrowserHelpersSection />)

    fireEvent.click(await screen.findByRole('button', { name: /Pair new browser helper/ }))

    expect(await screen.findByText('Too many pairing attempts')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalled()
  })
})
