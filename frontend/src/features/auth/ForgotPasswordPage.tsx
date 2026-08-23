import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { IconArrowRight } from '../../components/icons'
import { Input } from '../../components/Input'
import { AuthAlert, AuthCard, authFieldClassName, authFormClassName, AuthHeading, AuthPage } from './AuthLayout'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const requestReset = useMutation({
    mutationFn: () => apiRequest<void>('/api/v1/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  })

  return (
    <AuthPage>
      <AuthCard aria-labelledby="forgot-password-title">
        <AuthHeading eyebrow="Account recovery" title="Reset Your Password" titleId="forgot-password-title">
          <p>
            Enter the email address on your account and we will send you a link to
            choose a new password.
          </p>
        </AuthHeading>
        {requestReset.isSuccess ? (
          <AuthAlert tone="success" role="status">
            If an account exists for that email address, a password reset link is on
            its way. Check your inbox.
          </AuthAlert>
        ) : (
          <form className={authFormClassName} onSubmit={(event) => { event.preventDefault(); requestReset.mutate() }}>
            <label className={authFieldClassName}>
              Email address
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            {requestReset.error ? (
              <AuthAlert role="alert">{requestReset.error.message}</AuthAlert>
            ) : null}
            <Button type="submit" loading={requestReset.isPending} disabled={!email}>
              {requestReset.isPending ? 'Sending…' : 'Send Reset Link'}
              <IconArrowRight />
            </Button>
          </form>
        )}
        <Button as={Link} to="/login" variant="text" className="mt-6">Back to sign in</Button>
      </AuthCard>
    </AuthPage>
  )
}
