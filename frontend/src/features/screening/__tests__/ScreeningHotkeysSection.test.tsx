import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScreeningHotkeysSection } from '../ScreeningHotkeysSection'
import { sessionQueryOptions } from '../../auth/sessionQuery'
import { jsonResponse, mockFetch } from '../../../test/http'
import { createTestQueryClient, renderWithProviders } from '../../../test/render'

const baseUser = {
  id: 'user-1',
  username: 'reviewer1',
  displayName: 'Reviewer One',
  isAdmin: false,
  isActive: true,
  uiPreferences: {} as Record<string, unknown>,
}

function renderWithSession() {
  const queryClient = createTestQueryClient()
  queryClient.setQueryData(sessionQueryOptions.queryKey, { user: baseUser, csrfToken: 'csrf-token' })
  const fetchMock = mockFetch(async (input, init) => {
    if (String(input).endsWith('/auth/me') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { uiPreferences: Record<string, unknown> }
      return jsonResponse({ ...baseUser, uiPreferences: body.uiPreferences })
    }
    return jsonResponse({})
  })
  renderWithProviders(<ScreeningHotkeysSection />, { queryClient })
  return { queryClient, fetchMock }
}

describe('ScreeningHotkeysSection', () => {
  it('shows the default hotkeys', () => {
    renderWithSession()

    expect(screen.getByRole('button', { name: 'Include hotkey: I' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exclude hotkey: E' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Uncertain hotkey: U' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Duplicate hotkey: D' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit / Confirm hotkey: Enter' })).toBeInTheDocument()
  })

  it('captures a new key and persists it to the account', async () => {
    const { fetchMock } = renderWithSession()

    fireEvent.click(screen.getByRole('button', { name: 'Include hotkey: I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include hotkey: Press a key…' }), { key: 'k' })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Include hotkey: K' })).toBeInTheDocument())
    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/auth/me'))
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.uiPreferences.screeningHotkeys.include).toBe('k')
  })

  it('clears a hotkey with Backspace', async () => {
    renderWithSession()

    fireEvent.click(screen.getByRole('button', { name: 'Include hotkey: I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include hotkey: Press a key…' }), { key: 'Backspace' })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Include hotkey: Not set' })).toBeInTheDocument())
  })

  it('warns when two actions share the same key', async () => {
    renderWithSession()

    fireEvent.click(screen.getByRole('button', { name: 'Exclude hotkey: E' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Exclude hotkey: Press a key…' }), { key: 'i' })

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Two actions share the same key'))
  })

  it('captures Enter as a hotkey', async () => {
    renderWithSession()

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate hotkey: D' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Duplicate hotkey: Press a key…' }), { key: 'Enter' })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Duplicate hotkey: Enter' })).toBeInTheDocument())
  })

  it('resets to the default hotkeys', async () => {
    renderWithSession()

    fireEvent.click(screen.getByRole('button', { name: 'Include hotkey: I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include hotkey: Press a key…' }), { key: 'k' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Include hotkey: K' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Include hotkey: I' })).toBeInTheDocument())
  })
})
