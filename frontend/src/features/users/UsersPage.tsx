import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { ConfirmButton } from '../../components/ConfirmButton'
import type { LoginResponse, User } from '../auth/types'

export function UsersPage() {
  const queryClient = useQueryClient()
  const session = queryClient.getQueryData<LoginResponse>(['session'])
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => apiRequest<User[]>('/api/v1/users'),
  })
  const create = useMutation({
    mutationFn: () => apiRequest<User>('/api/v1/users', {
      method: 'POST',
      body: JSON.stringify({ username, displayName, password }),
    }),
    onSuccess: () => {
      setUsername('')
      setDisplayName('')
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
      <h1>Users</h1>
      {showCreateForm ? (
        <section className="card">
          <h2>Create Reviewer</h2>
          <form onSubmit={(event) => { event.preventDefault(); create.mutate() }}>
            <label>
              Username
              <input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              Display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                required
              />
            </label>
            <label>
              Temporary password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                required
              />
            </label>
            <div className="toolbar">
              <button type="submit" disabled={create.isPending}>Create Reviewer</button>
              <button type="button" onClick={() => setShowCreateForm(false)}>Cancel</button>
            </div>
          </form>
        </section>
      ) : (
        <div className="toolbar">
          <button type="button" onClick={() => setShowCreateForm(true)}>Add Reviewer</button>
        </div>
      )}
      {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
      {setActive.error ? <p className="error" role="alert">{setActive.error.message}</p> : null}
      {users.isLoading ? <p>Loading…</p> : null}
      {users.error ? <p className="error" role="alert">{users.error.message}</p> : null}
      {users.data ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Display name</th>
              <th scope="col">Username</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((user) => (
              <tr key={user.id}>
                <td>{user.displayName}</td>
                <td>{user.username}</td>
                <td>{user.isActive ? 'active' : 'disabled'}</td>
                <td>
                  {user.id === session?.user.id ? null : user.isActive ? (
                    <ConfirmButton
                      label="Remove"
                      warning={`Remove ${user.displayName}? They will no longer be able to sign in or be assigned new work. Their existing screening, extraction, and audit history is kept, and an admin can reactivate the account later.`}
                      onConfirm={() => setActive.mutate({ id: user.id, isActive: false })}
                      disabled={setActive.isPending}
                      variant="danger"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setActive.mutate({ id: user.id, isActive: true })}
                      disabled={setActive.isPending}
                    >
                      Reactivate
                    </button>
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
