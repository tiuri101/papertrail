import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CountPill } from '../../components/CountPill'
import { IconPlus, IconRestart, IconTrash } from '../../components/icons'
import { Input } from '../../components/Input'
import type { LoginResponse, User } from '../auth/types'

export function UsersPage() {
  const queryClient = useQueryClient()
  const session = queryClient.getQueryData<LoginResponse>(['session'])
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => apiRequest<User[]>('/api/v1/users'),
  })
  const create = useMutation({
    mutationFn: () => apiRequest<User>('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify({ username, displayName, email, password }),
    }),
    onSuccess: () => {
      setUsername('')
      setDisplayName('')
      setEmail('')
      setPassword('')
      setShowCreateForm(false)
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })
  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => apiRequest<User>(`/api/v1/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  return (
    <main className="page">
      <p className="mb-1 text-xs font-bold uppercase tracking-[0.08em] text-primary">Installation administration</p>
      <h1>Users</h1>
      <p className="text-text">Manage reviewer accounts for this Papertrail installation.</p>
      {showCreateForm ? (
        <Card as="section">
          <h2>Create Reviewer</h2>
          <form onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
            <label>
              Username
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              Display name
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
            <label>
              Email address
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="reviewer@example.org"
              />
              <small>Optional. Notifications are sent only when email is configured.</small>
            </label>
            <label>
              Temporary password
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={create.isPending}><IconPlus />Create Reviewer</Button>
              <Button type="button" variant="secondary" onClick={() => setShowCreateForm(false)}>Cancel</Button>
            </div>
          </form>
        </Card>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => setShowCreateForm(true)}><IconPlus />Add Reviewer</Button>
        </div>
      )}
      {create.error ? <p className="text-danger" role="alert">{create.error.message}</p> : null}
      {setActive.error ? <p className="text-danger" role="alert">{setActive.error.message}</p> : null}
      {users.isLoading ? <p>Loading…</p> : null}
      {users.error ? <p className="text-danger" role="alert">{users.error.message}</p> : null}
      {users.data ? (
        <CountPill count={users.data.length}>user{users.data.length === 1 ? '' : 's'}</CountPill>
      ) : null}
      {users.data ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Display name</th>
              <th scope="col">Username</th>
              <th scope="col">Email</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((user) => (
              <tr key={user.id}>
                <td>{user.displayName}</td>
                <td>{user.username}</td>
                <td>{user.email || '—'}</td>
                <td>{user.isActive ? 'active' : 'disabled'}</td>
                <td>
                  {user.id === session?.user.id ? null : user.isActive ? (
                    <ConfirmButton
                      label="Remove"
                      warning={`Remove ${user.displayName}? They will no longer be able to sign in or be assigned new work. Their existing screening, extraction, and audit history is kept, and an admin can reactivate the account later.`}
                      onConfirm={() => setActive.mutate({ id: user.id, isActive: false })}
                      disabled={setActive.isPending}
                      variant="danger"
                      icon={<IconTrash />}
                    />
                  ) : (
                    <Button
                      type="button"
                      onClick={() => setActive.mutate({ id: user.id, isActive: true })}
                      loading={setActive.isPending}
                    >
                      <IconRestart />
                      Reactivate
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
  )
}
