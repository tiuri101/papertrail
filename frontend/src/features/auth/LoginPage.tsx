import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { setCsrfToken } from './session'
import type { LoginResponse } from './types'

export function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: () => apiRequest<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
    onSuccess: (data) => {
      setCsrfToken(data.csrfToken)
      queryClient.setQueryData(['session'], data)
      navigate('/')
    },
  })

  return (
    <main className="page narrow">
      <h1>Sign in to Papertrail</h1>
      <form onSubmit={(event) => { event.preventDefault(); login.mutate() }}>
        <label>
          Username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {login.error ? <p role="alert">{login.error.message}</p> : null}
        <button type="submit" disabled={login.isPending}>Sign in</button>
      </form>
    </main>
  )
}
