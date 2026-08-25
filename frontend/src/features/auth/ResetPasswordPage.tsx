import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { IconCheckCircle } from '../../components/icons'
import { Input } from '../../components/Input'
import { AuthAlert, AuthCard, authFieldClassName, authFormClassName, AuthHeading, AuthPage } from './AuthLayout'
import { MIN_PASSWORD_LENGTH, PASSWORD_REQUIREMENTS_TEXT, passwordMeetsPolicy } from './passwordPolicy'
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
    <AuthPage>
      <AuthCard aria-labelledby="reset-password-title">
        <AuthHeading eyebrow="Account recovery" title="Choose a New Password" titleId="reset-password-title">
          <p>Set a new password to regain access to your account.</p>
        </AuthHeading>
        {token ? (
          <form className={authFormClassName} onSubmit={(event) => { event.preventDefault(); resetPassword.mutate() }}>
            {/* The hint sits outside the <label> on purpose: this label wraps
                its control, so anything inside it becomes part of the field's
                accessible name. */}
            <div className="grid gap-2">
              <label className={authFieldClassName}>
                New password
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  aria-describedby="reset-password-requirements"
                  required
                />
              </label>
              <small id="reset-password-requirements" className="text-text-secondary">{PASSWORD_REQUIREMENTS_TEXT}</small>
            </div>
            <label className={authFieldClassName}>
              Confirm new password
              <Input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                required
              />
            </label>
            {passwordsMismatch ? (
              <AuthAlert role="alert">New passwords do not match.</AuthAlert>
            ) : null}
            {resetPassword.error ? (
              <AuthAlert role="alert">{resetPassword.error.message}</AuthAlert>
            ) : null}
            <Button
              type="submit"
              loading={resetPassword.isPending}
              disabled={!passwordMeetsPolicy(newPassword) || passwordsMismatch}
            >
              <IconCheckCircle />
              {resetPassword.isPending ? 'Updating…' : 'Set New Password'}
            </Button>
          </form>
        ) : (
          <AuthAlert role="alert">
            This password reset link is missing its token. Request a new link to
            continue.
          </AuthAlert>
        )}
        <Button as={Link} to="/forgot-password" variant="text" className="mt-6">Request a new link</Button>
      </AuthCard>
    </AuthPage>
  )
}
