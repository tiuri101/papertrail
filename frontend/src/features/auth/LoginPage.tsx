import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { ThemeToggle } from '../../components/ThemeToggle'
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
    <main className="login-page">
      <div className="login-theme-control">
        <ThemeToggle />
      </div>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand" aria-hidden="true">
          <span className="brand-mark brand-mark--large">
            <svg viewBox="0 0 24 24">
              <path d="M6 3h8.5L19 7.5V21H6V3Zm2 2v14h9V9h-4V5H8Zm7 1.4V7h.6L15 6.4Z" />
              <path d="M9.5 11h5v1.7h-5V11Zm0 3.4h5v1.7h-5v-1.7Z" />
            </svg>
          </span>
          <span>Papertrail</span>
        </div>
        <div className="login-heading">
          <p className="eyebrow">Academic review workspace</p>
          <h1 id="login-title">Sign In to Papertrail</h1>
          <p className="muted">Continue to your literature review projects.</p>
        </div>
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
          {login.error ? <p className="error alert" role="alert">{login.error.message}</p> : null}
          <button type="submit" disabled={login.isPending}>
            {login.isPending ? 'Signing In…' : 'Sign In'}
          </button>
        </form>
        <Link to="/forgot-password" className="link-button">Forgot your password?</Link>
      </section>
    </main>
  )
}
