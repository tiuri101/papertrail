import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { IconArrowRight, IconEye, IconEyeOff } from '../../components/icons'
import { Button, IconButton } from '../../components/Button'
import { DecorativeDocTrail } from '../../components/DecorativeDocTrail'
import { ThemeToggle } from '../../components/ThemeToggle'
import { setCsrfToken } from './session'
import type { LoginResponse } from './types'

const REMEMBERED_USERNAME_KEY = 'papertrail.remembered-username'

export function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState(() => localStorage.getItem(REMEMBERED_USERNAME_KEY) ?? '')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(() => Boolean(localStorage.getItem(REMEMBERED_USERNAME_KEY)))
  const [showPassword, setShowPassword] = useState(false)
  const login = useMutation({
    mutationFn: () => apiRequest<LoginResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
    onSuccess: (data) => {
      if (rememberMe) {
        localStorage.setItem(REMEMBERED_USERNAME_KEY, username)
      } else {
        localStorage.removeItem(REMEMBERED_USERNAME_KEY)
      }
      setCsrfToken(data.csrfToken)
      queryClient.setQueryData(['session'], data)
      navigate('/')
    },
  })

  return (
    <main className="login-page">
      <div className="login-shell">
        <header className="login-header">
          <Link to="/" className="login-header-brand" aria-label="Papertrail home">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 3h8.5L19 7.5V21H6V3Zm2 2v14h9V9h-4V5H8Zm7 1.4V7h.6L15 6.4Z" />
                <path d="M9.5 11h5v1.7h-5V11Zm0 3.4h5v1.7h-5v-1.7Z" />
              </svg>
            </span>
            <span>Papertrail</span>
          </Link>
          <ThemeToggle />
        </header>
        <div className="login-layout">
          <section className="login-intro" aria-hidden="true">
            <h2 className="login-intro__title">Papertrail</h2>
            <p>Systematic reviews. Traceable decisions.</p>
            <DecorativeDocTrail className="login-illustration" />
          </section>
          <section className="login-card" aria-labelledby="login-title">
            <div className="login-heading">
              <h1 id="login-title">Welcome back</h1>
              <p className="muted">Sign in to continue</p>
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
                <div className="login-password-field">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <IconButton
                    type="button"
                    variant="ghost"
                    className="login-password-toggle"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((visible) => !visible)}
                  >
                    {showPassword ? <IconEyeOff /> : <IconEye />}
                  </IconButton>
                </div>
              </label>
              <div className="login-field-row">
                <label className="login-remember">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(event) => setRememberMe(event.target.checked)}
                  />
                  Remember me
                </label>
                <Link to="/forgot-password" className="link-button">Forgot password?</Link>
              </div>
              {login.error ? <p className="error alert" role="alert">{login.error.message}</p> : null}
              <Button type="submit" className="relative [&_svg]:absolute [&_svg]:right-4" loading={login.isPending}>
                {login.isPending ? 'Signing in…' : 'Sign in'}
                <IconArrowRight />
              </Button>
            </form>
          </section>
        </div>
      </div>
    </main>
  )
}
