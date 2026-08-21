import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { IconArrowRight } from '../../components/icons'
import { ThemeToggle } from '../../components/ThemeToggle'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const requestReset = useMutation({
    mutationFn: () => apiRequest<void>('/api/v1/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  })

  return (
    <main className="login-page">
      <div className="login-theme-control">
        <ThemeToggle />
      </div>
      <section className="login-card" aria-labelledby="forgot-password-title">
        <div className="login-heading">
          <p className="eyebrow">Account recovery</p>
          <h1 id="forgot-password-title">Reset Your Password</h1>
          <p className="muted">
            Enter the email address on your account and we will send you a link to
            choose a new password.
          </p>
        </div>
        {requestReset.isSuccess ? (
          <p className="success alert" role="status">
            If an account exists for that email address, a password reset link is on
            its way. Check your inbox.
          </p>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); requestReset.mutate() }}>
            <label>
              Email address
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            {requestReset.error ? (
              <p className="error alert" role="alert">{requestReset.error.message}</p>
            ) : null}
            <Button type="submit" loading={requestReset.isPending} disabled={!email}>
              {requestReset.isPending ? 'Sending…' : 'Send Reset Link'}
              <IconArrowRight />
            </Button>
          </form>
        )}
        <Link to="/login" className="link-button">Back to sign in</Link>
      </section>
    </main>
  )
}
