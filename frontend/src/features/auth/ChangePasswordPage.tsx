import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { IconCheckCircle } from '../../components/icons'
import { Input } from '../../components/Input'
import { AuthAlert, AuthCard, authFieldClassName, authFormClassName, AuthHeading, AuthPage } from './AuthLayout'
import { setCsrfToken } from './session'
import { sessionQueryOptions } from './sessionQuery'
import type { LoginResponse, User } from './types'

export function ChangePasswordPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const session = queryClient.getQueryData<LoginResponse>(sessionQueryOptions.queryKey)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showWelcomeDialog, setShowWelcomeDialog] = useState(false)

  const logout = useMutation({
    mutationFn: () => apiRequest<void>('/api/v1/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      setCsrfToken(null)
      queryClient.clear()
      navigate('/login')
    },
  })

  const updatePassword = useMutation({
    mutationFn: () => apiRequest<User>('/api/v1/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
    onSuccess: (user) => {
      queryClient.setQueryData<LoginResponse>(sessionQueryOptions.queryKey, (current) =>
        current ? { ...current, user } : current)
      setShowWelcomeDialog(true)
    },
  })

  const passwordsMismatch = newPassword.length > 0 && newPassword !== confirmPassword
  const passwordUnchanged = currentPassword.length > 0 && newPassword === currentPassword

  return (
    <AuthPage>
      <AuthCard aria-labelledby="change-password-title">
        <AuthHeading
          eyebrow={<>Welcome{session?.user.displayName ? `, ${session.user.displayName}` : ''}</>}
          title="Set a New Password"
          titleId="change-password-title"
        >
          <p>
            Your account was just created. Choose a new password to continue.
          </p>
        </AuthHeading>
        <form className={authFormClassName} onSubmit={(event) => { event.preventDefault(); updatePassword.mutate() }}>
          <label className={authFieldClassName}>
            Current password
            <Input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label className={authFieldClassName}>
            New password
            <Input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </label>
          <label className={authFieldClassName}>
            Confirm new password
            <Input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </label>
          {passwordUnchanged ? (
            <AuthAlert role="alert">
              New password must be different from your current password.
            </AuthAlert>
          ) : null}
          {passwordsMismatch ? <AuthAlert role="alert">New passwords do not match.</AuthAlert> : null}
          {updatePassword.error ? <AuthAlert role="alert">{updatePassword.error.message}</AuthAlert> : null}
          <Button
            type="submit"
            loading={updatePassword.isPending}
            disabled={
              !currentPassword
              || newPassword.length < 8
              || passwordUnchanged
              || passwordsMismatch
            }
          >
            <IconCheckCircle />
            {updatePassword.isPending ? 'Updating…' : 'Set Password'}
          </Button>
        </form>
        <Button
          type="button"
          variant="secondary"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          Sign Out
        </Button>
      </AuthCard>
      {showWelcomeDialog ? (
        <ConfirmDialog
          title="New to Papertrail?"
          message="Take a look at the Help section for a quick guide to the review process, roles, and key features—or continue straight to the application."
          confirmLabel="Explore Help"
          cancelLabel="Continue to Papertrail"
          onConfirm={() => navigate('/help')}
          onCancel={() => navigate('/')}
        />
      ) : null}
    </AuthPage>
  )
}
