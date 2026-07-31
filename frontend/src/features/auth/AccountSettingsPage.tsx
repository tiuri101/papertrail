import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import type { LoginResponse, User } from './types'
import { sessionQueryOptions } from './sessionQuery'

export function AccountSettingsPage() {
  const queryClient = useQueryClient()
  const session = queryClient.getQueryData<LoginResponse>(sessionQueryOptions.queryKey)
  const [displayName, setDisplayName] = useState(session?.user.displayName ?? '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const updateProfile = useMutation({
    mutationFn: () => apiRequest<User>('/api/v1/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ displayName }),
    }),
    onSuccess: (user) => {
      queryClient.setQueryData<LoginResponse>(sessionQueryOptions.queryKey, (current) =>
        current ? { ...current, user } : current)
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
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    },
  })

  const passwordsMismatch = newPassword.length > 0 && newPassword !== confirmPassword

  return (
    <main className="page">
      <h1>Account Settings</h1>
      <section className="card">
        <h2>Display Name</h2>
        <form onSubmit={(event) => { event.preventDefault(); updateProfile.mutate() }}>
          <label>
            Display name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </label>
          {updateProfile.error ? <p className="error" role="alert">{updateProfile.error.message}</p> : null}
          {updateProfile.isSuccess ? <p>Display name updated.</p> : null}
          <button type="submit" disabled={updateProfile.isPending || !displayName.trim()}>
            Save Display Name
          </button>
        </form>
      </section>
      <section className="card">
        <h2>Password</h2>
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
          {passwordsMismatch ? <p className="error" role="alert">New passwords do not match.</p> : null}
          {updatePassword.error ? <p className="error" role="alert">{updatePassword.error.message}</p> : null}
          {updatePassword.isSuccess ? <p>Password updated.</p> : null}
          <button
            type="submit"
            disabled={
              updatePassword.isPending
              || !currentPassword
              || newPassword.length < 8
              || passwordsMismatch
            }
          >
            Change Password
          </button>
        </form>
      </section>
    </main>
  )
}
