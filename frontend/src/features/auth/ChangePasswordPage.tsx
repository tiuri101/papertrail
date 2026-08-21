import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { IconCheckCircle } from '../../components/icons'
import { Input } from '../../components/Input'
import { ThemeToggle } from '../../components/ThemeToggle'
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
    <main className="login-page">
      <div className="login-theme-control">
        <ThemeToggle />
      </div>
      <section className="login-card" aria-labelledby="change-password-title">
        <div className="login-heading">
          <p className="eyebrow">Welcome{session?.user.displayName ? `, ${session.user.displayName}` : ''}</p>
          <h1 id="change-password-title">Set a New Password</h1>
          <p className="muted">
            Your account was just created. Choose a new password to continue.
          </p>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); updatePassword.mutate() }}>
          <label>
            Current password
            <Input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label>
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
          <label>
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
            <p className="error alert" role="alert">
              New password must be different from your current password.
            </p>
          ) : null}
          {passwordsMismatch ? <p className="error alert" role="alert">New passwords do not match.</p> : null}
          {updatePassword.error ? <p className="error alert" role="alert">{updatePassword.error.message}</p> : null}
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
      </section>
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
    </main>
  )
}
