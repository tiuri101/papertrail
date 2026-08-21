import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { IconCheckCircle } from '../../components/icons'
import { ThemeToggle } from '../../components/ThemeToggle'
import { setCsrfToken } from './session'
import type { LoginResponse } from './types'

export function ResetPasswordPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const resetPassword = useMutation({
    mutationFn: () => apiRequest<LoginResponse>('/api/v1/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),
    onSuccess: (data) => {
      setCsrfToken(data.csrfToken)
      queryClient.setQueryData(['session'], data)
      navigate('/')
    },
  })

  const passwordsMismatch = newPassword.length > 0 && newPassword !== confirmPassword

  return (
    <main className="login-page">
      <div className="login-theme-control">
        <ThemeToggle />
      </div>
      <section className="login-card" aria-labelledby="reset-password-title">
        <div className="login-heading">
          <p className="eyebrow">Account recovery</p>
          <h1 id="reset-password-title">Choose a New Password</h1>
          <p className="muted">Set a new password to regain access to your account.</p>
        </div>
        {token ? (
          <form onSubmit={(event) => { event.preventDefault(); resetPassword.mutate() }}>
            <label>
              New password
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            {passwordsMismatch ? (
              <p className="error alert" role="alert">New passwords do not match.</p>
            ) : null}
            {resetPassword.error ? (
              <p className="error alert" role="alert">{resetPassword.error.message}</p>
            ) : null}
            <Button
              type="submit"
              loading={resetPassword.isPending}
              disabled={newPassword.length < 8 || passwordsMismatch}
            >
              <IconCheckCircle />
              {resetPassword.isPending ? 'Updating…' : 'Set New Password'}
            </Button>
          </form>
        ) : (
          <p className="error alert" role="alert">
            This password reset link is missing its token. Request a new link to
            continue.
          </p>
        )}
        <Link to="/forgot-password" className="link-button">Request a new link</Link>
      </section>
    </main>
  )
}
