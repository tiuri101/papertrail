import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { apiRequest } from '../../api/client'

export interface BrowserAgent {
  id: string
  displayName: string
  extensionVersion: string | null
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

export interface PairingSecret {
  pairingSecret: string
  expiresAt: string
  serverUrl: string
}

const agentsQueryKey = ['browser-agents']
const PAIRING_POLL_INTERVAL_MS = 3000

// A newly paired agent is created by the extension calling the backend directly, not by
// any request this tab makes, so poll the list while a pairing secret is on screen instead
// of waiting for the reviewer to refresh the page.
export function useBrowserAgents(pairingInProgress = false) {
  const queryClient = useQueryClient()

  const agents = useQuery({
    queryKey: agentsQueryKey,
    queryFn: () => apiRequest<BrowserAgent[]>('/api/v1/browser-agents'),
  })

  useEffect(() => {
    if (!pairingInProgress) return
    const interval = window.setInterval(() => {
      queryClient.invalidateQueries({ queryKey: agentsQueryKey })
    }, PAIRING_POLL_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [pairingInProgress, queryClient])

  const createPairingSecret = useMutation({
    mutationFn: () => apiRequest<PairingSecret>('/api/v1/browser-agents/pairing-secrets', {
      method: 'POST',
    }),
  })

  const revoke = useMutation({
    mutationFn: (agentId: string) => apiRequest<void>(`/api/v1/browser-agents/${agentId}`, {
      method: 'DELETE',
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentsQueryKey })
    },
  })

  return { agents, createPairingSecret, revoke }
}
