import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { IconArrowRight, IconEye, IconEyeOff } from '../../components/icons'
import { Button, IconButton } from '../../components/Button'
import { DecorativeDocTrail } from '../../components/DecorativeDocTrail'
import { Input } from '../../components/Input'
import { ThemeToggle } from '../../components/ThemeToggle'
import { AuthAlert, AuthCard, authFieldClassName, authFormClassName, AuthHeading, AuthPage } from './AuthLayout'
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
    <AuthPage showThemeToggle={false}>
      <div className="grid w-full max-w-[1040px] gap-8">
        <header className="flex items-center justify-between">
          <Link to="/" className="inline-flex items-center gap-3 text-[1.05rem] font-bold tracking-[-0.025em] text-text no-underline" aria-label="Papertrail home">
            <span className="inline-grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-linear-to-br from-primary to-primary-strong text-primary-contrast shadow-[0_7px_20px_var(--color-primary-container-hover)] [&_svg]:size-[21px] [&_svg]:fill-current" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M6 3h8.5L19 7.5V21H6V3Zm2 2v14h9V9h-4V5H8Zm7 1.4V7h.6L15 6.4Z" />
                <path d="M9.5 11h5v1.7h-5V11Zm0 3.4h5v1.7h-5v-1.7Z" />
              </svg>
            </span>
            <span>Papertrail</span>
          </Link>
          <ThemeToggle />
        </header>
        <div className="grid items-center gap-10 min-[861px]:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          <section className="grid justify-items-center gap-3 p-0 text-center min-[861px]:justify-items-stretch min-[861px]:px-6 min-[861px]:text-left" aria-hidden="true">
            <h2 className="m-0 text-[clamp(2.1rem,4vw,2.9rem)] font-bold tracking-[-0.03em]">Papertrail</h2>
            <p className="m-0 text-[1.05rem] text-text-secondary">Systematic reviews. Traceable decisions.</p>
            <DecorativeDocTrail className="mt-4 hidden h-auto max-h-[68vh] w-full max-w-[230px] min-[861px]:block" />
          </section>
          <AuthCard aria-labelledby="login-title">
            <AuthHeading title="Welcome back" titleId="login-title">
              <p>Sign in to continue</p>
            </AuthHeading>
            <form className={authFormClassName} onSubmit={(event) => { event.preventDefault(); login.mutate() }}>
              <label className={authFieldClassName}>
                Username
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  required
                />
              </label>
              <label className={authFieldClassName}>
                Password
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    className="pr-12"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <IconButton
                    type="button"
                    variant="ghost"
                    className="absolute right-0.5 top-1/2 -translate-y-1/2"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    onClick={() => setShowPassword((visible) => !visible)}
                  >
                    {showPassword ? <IconEyeOff /> : <IconEye />}
                  </IconButton>
                </div>
              </label>
              <div className="-mt-3 flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm font-semibold text-text-secondary">
                  <Input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(event) => setRememberMe(event.target.checked)}
                  />
                  Remember me
                </label>
                <Button as={Link} to="/forgot-password" variant="text">Forgot password?</Button>
              </div>
              {login.error ? <AuthAlert role="alert">{login.error.message}</AuthAlert> : null}
              <Button type="submit" className="relative [&_svg]:absolute [&_svg]:right-4" loading={login.isPending}>
                {login.isPending ? 'Signing in…' : 'Sign in'}
                <IconArrowRight />
              </Button>
            </form>
          </AuthCard>
        </div>
      </div>
    </AuthPage>
  )
}
