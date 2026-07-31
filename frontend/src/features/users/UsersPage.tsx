import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import type { User } from '../auth/types'

export function UsersPage() {
  const queryClient = useQueryClient()
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

  return (
    <main className="page">
      <h1>Users</h1>
      {showCreateForm ? (
        <section className="card">
          <h2>Create reviewer</h2>
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
              <button type="submit" disabled={create.isPending}>Create reviewer</button>
              <button type="button" onClick={() => setShowCreateForm(false)}>Cancel</button>
            </div>
          </form>
        </section>
      ) : (
        <div className="toolbar">
          <button type="button" onClick={() => setShowCreateForm(true)}>Add reviewer</button>
        </div>
      )}
      {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
      {users.isLoading ? <p>Loading…</p> : null}
      {users.error ? <p className="error" role="alert">{users.error.message}</p> : null}
      {users.data ? (
        <table>
          <thead>
            <tr>
              <th scope="col">Display name</th>
              <th scope="col">Username</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((user) => (
              <tr key={user.id}>
                <td>{user.displayName}</td>
                <td>{user.username}</td>
                <td>{user.isActive ? 'active' : 'disabled'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
  )
}
