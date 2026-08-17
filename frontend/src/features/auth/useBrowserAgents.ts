import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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

export function useBrowserAgents() {
  const queryClient = useQueryClient()

  const agents = useQuery({
    queryKey: agentsQueryKey,
    queryFn: () => apiRequest<BrowserAgent[]>('/api/v1/browser-agents'),
  })

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
