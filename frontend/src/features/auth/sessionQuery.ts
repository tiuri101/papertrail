import { queryOptions, useQuery } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { setCsrfToken } from './session'
import type { LoginResponse } from './types'

export const sessionQueryOptions = queryOptions({
  queryKey: ['session'],
  queryFn: async () => {
    const result = await apiRequest<LoginResponse>('/api/v1/auth/session')
    setCsrfToken(result.csrfToken)
    return result
  },
  retry: false,
})

export function useSession() {
  return useQuery(sessionQueryOptions)
}
