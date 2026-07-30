import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import type { User } from '../auth/types'

export function UsersPage() {
  const queryClient = useQueryClient()
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
      queryClient.invalidateQueries({ queryKey: ['users'] })
    },
  })

  return (
    <main className="page">
      <h1>Users</h1>
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
          <button type="submit" disabled={create.isPending}>Create reviewer</button>
        </form>
      </section>
      {create.error ? <p className="error" role="alert">{create.error.message}</p> : null}
      {users.isLoading ? <p>Loading…</p> : null}
      {users.error ? <p className="error" role="alert">{users.error.message}</p> : null}
      <ul>
        {users.data?.map((user) => (
          <li key={user.id}>
            {user.displayName} ({user.username}) — {user.isActive ? 'active' : 'disabled'}
          </li>
        ))}
      </ul>
    </main>
  )
}
