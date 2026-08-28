import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'

import { apiRequest } from '../api/client'
import { sessionQueryOptions } from '../features/auth/sessionQuery'
import type { LoginResponse, User } from '../features/auth/types'

// Fired whenever a preference is saved, so non-component listeners (e.g. a
// keydown handler registered in an effect) can pick up the change without
// subscribing to the query cache themselves. Mirrors the localStorage-era
// cross-listener pattern this replaced, but scoped to the current tab only --
// preferences now live server-side, so another tab picks them up on its own
// next session fetch rather than through a "storage" event.
export const UI_PREFERENCES_CHANGED_EVENT = 'papertrail:ui-preferences-changed'

export function getUiPreferences(queryClient: QueryClient): Record<string, unknown> {
  return queryClient.getQueryData<LoginResponse>(sessionQueryOptions.queryKey)?.user.uiPreferences ?? {}
}

/**
 * Reads and persists one namespaced key (e.g. "screeningHotkeys") inside the
 * signed-in reviewer's `uiPreferences` blob. Saving PATCHes the whole blob
 * with that key replaced -- the backend stores it opaquely, so there's no
 * partial-merge behavior to coordinate with it.
 */
export function useUiPreference<T>(key: string, defaultValue: T) {
  const queryClient = useQueryClient()
  const preferences = getUiPreferences(queryClient)
  const value = (preferences[key] as T | undefined) ?? defaultValue

  const mutation = useMutation({
    mutationFn: (next: T) => apiRequest<User>('/api/v1/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ uiPreferences: { ...getUiPreferences(queryClient), [key]: next } }),
    }),
    onSuccess: (user) => {
      queryClient.setQueryData<LoginResponse>(sessionQueryOptions.queryKey, (session) =>
        session ? { ...session, user } : session)
      window.dispatchEvent(new Event(UI_PREFERENCES_CHANGED_EVENT))
    },
  })

  return {
    value,
    setValue: (next: T) => mutation.mutate(next),
    isSaving: mutation.isPending,
    error: mutation.error,
  }
}
