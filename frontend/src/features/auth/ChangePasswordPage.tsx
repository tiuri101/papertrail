import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { apiRequest } from '../../api/client'
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
      navigate('/')
    },
  })

  const passwordsMismatch = newPassword.length > 0 && newPassword !== confirmPassword

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
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
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
          {passwordsMismatch ? <p className="error alert" role="alert">New passwords do not match.</p> : null}
          {updatePassword.error ? <p className="error alert" role="alert">{updatePassword.error.message}</p> : null}
          <button
            type="submit"
            disabled={
              updatePassword.isPending
              || !currentPassword
              || newPassword.length < 8
              || passwordsMismatch
            }
          >
            {updatePassword.isPending ? 'Updating…' : 'Set Password'}
          </button>
        </form>
        <button
          type="button"
          className="button-secondary"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          Sign Out
        </button>
      </section>
    </main>
  )
}
