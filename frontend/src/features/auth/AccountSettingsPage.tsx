import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconCheckCircle, IconPerson, IconSettings } from '../../components/icons'
import { Input } from '../../components/Input'
import { SectionNavigationLayout } from '../../components/SectionNavigationLayout'
import { ScreeningHotkeysSection } from '../screening/ScreeningHotkeysSection'
import { BrowserHelpersSection } from './BrowserHelpersSection'
import type { LoginResponse, User } from './types'
import { sessionQueryOptions } from './sessionQuery'

const accountSections = [
  { id: 'section-account-profile', label: 'Profile' },
  { id: 'section-account-password', label: 'Password' },
  { id: 'section-account-hotkeys', label: 'Screening Hotkeys' },
  { id: 'section-account-browser-helpers', label: 'Browser Helpers' },
]

export function AccountSettingsPage() {
  const queryClient = useQueryClient()
  const session = queryClient.getQueryData<LoginResponse>(sessionQueryOptions.queryKey)
  const [displayName, setDisplayName] = useState(session?.user.displayName ?? '')
  const [email, setEmail] = useState(session?.user.email ?? '')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const updateProfile = useMutation({
    mutationFn: (next: { displayName: string; email: string }) => apiRequest<User>('/api/v1/auth/me', {
      method: 'PATCH',
      body: JSON.stringify(next),
    }),
    onSuccess: (user) => {
      queryClient.setQueryData<LoginResponse>(sessionQueryOptions.queryKey, (current) =>
        current ? { ...current, user } : current)
    },
  })

  const saveProfileIfChanged = () => {
    if (!session) return
    if (!displayName.trim()) return
    if (displayName === session.user.displayName && email === (session.user.email ?? '')) return
    updateProfile.mutate({ displayName, email })
  }

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
  const passwordUnchanged = currentPassword.length > 0 && newPassword === currentPassword

  return (
    <SectionNavigationLayout items={accountSections}>
      <main className="page">
        <p className="eyebrow">Personal settings</p>
        <h1>Account Settings</h1>
        <p className="muted">Manage your profile, password, and personal preferences.</p>
        <CollapsibleSection id="section-account-profile" title="Profile" icon={<IconPerson />}>
          <p className="muted">Changes save automatically when you leave a field.</p>
          <label>
            Display name
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              onBlur={saveProfileIfChanged}
              required
            />
          </label>
          <label>
            Email address
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onBlur={saveProfileIfChanged}
              placeholder="you@example.org"
            />
          </label>
          {updateProfile.error ? <p className="error" role="alert">{updateProfile.error.message}</p> : null}
          <p className="muted" aria-live="polite">
            {updateProfile.isPending ? 'Saving…' : updateProfile.isSuccess ? 'Saved.' : ' '}
          </p>
        </CollapsibleSection>
        <CollapsibleSection id="section-account-password" title="Password" icon={<IconSettings />}>
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
              <p className="error" role="alert">
                New password must be different from your current password.
              </p>
            ) : null}
            {passwordsMismatch ? <p className="error" role="alert">New passwords do not match.</p> : null}
            {updatePassword.error ? <p className="error" role="alert">{updatePassword.error.message}</p> : null}
            {updatePassword.isSuccess ? <p>Password updated.</p> : null}
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
              Change Password
            </Button>
          </form>
        </CollapsibleSection>
        <ScreeningHotkeysSection />
        <BrowserHelpersSection />
      </main>
    </SectionNavigationLayout>
  )
}
