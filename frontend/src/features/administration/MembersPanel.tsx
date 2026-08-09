import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import type { User } from '../auth/types'

type RoleKey =
  | 'canTitleAbstractScreen'
  | 'canFullTextScreen'
  | 'canExtract'
  | 'canAssessQuality'
  | 'canAdjudicate'

interface Membership extends Record<RoleKey, boolean> {
  id: string
  userId: string
}

interface ProjectMembers {
  id: string
  memberships: Membership[]
}

const ROLE_FIELDS: Array<[RoleKey, string]> = [
  ['canTitleAbstractScreen', 'Title/abstract screening'],
  ['canFullTextScreen', 'Full-text screening'],
  ['canExtract', 'Data extraction'],
  ['canAssessQuality', 'Quality assessment'],
  ['canAdjudicate', 'Adjudication'],
]

const emptyRoles: Record<RoleKey, boolean> = {
  canTitleAbstractScreen: false,
  canFullTextScreen: false,
  canExtract: false,
  canAssessQuality: false,
  canAdjudicate: false,
}

function rolesOf(membership: Membership): Record<RoleKey, boolean> {
  return ROLE_FIELDS.reduce((acc, [field]) => {
    acc[field] = membership[field]
    return acc
  }, {} as Record<RoleKey, boolean>)
}

function MemberRow({
  label,
  membership,
  onSave,
  onDelete,
  pending,
}: {
  label: string
  membership: Membership
  onSave: (roles: Record<RoleKey, boolean>) => void
  onDelete: () => void
  pending: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<RoleKey, boolean>>(rolesOf(membership))

  if (editing) {
    return (
      <tr>
        <td>{label}</td>
        <td colSpan={2}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              setEditing(false)
              onSave(draft)
            }}
          >
            <fieldset>
              <legend className="subsection-heading">Stages</legend>
              {ROLE_FIELDS.map(([field, fieldLabel]) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    checked={draft[field]}
                    onChange={(event) => setDraft({ ...draft, [field]: event.target.checked })}
                  />
                  {fieldLabel}
                </label>
              ))}
            </fieldset>
            <div className="toolbar">
              <button type="submit" disabled={pending}>Save</button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => { setDraft(rolesOf(membership)); setEditing(false) }}
              >
                Cancel
              </button>
            </div>
          </form>
        </td>
      </tr>
    )
  }

  const activeRoles = ROLE_FIELDS
    .filter(([field]) => membership[field])
    .map(([, fieldLabel]) => fieldLabel)

  return (
    <tr>
      <td>{label}</td>
      <td>{activeRoles.length > 0 ? activeRoles.join(', ') : 'No roles assigned'}</td>
      <td>
        <div className="toolbar">
          <button type="button" onClick={() => setEditing(true)} disabled={pending}>Edit</button>
          <ConfirmButton
            label="Remove"
            warning="Remove this reviewer from the project? This cannot be undone."
            onConfirm={onDelete}
            disabled={pending}
          />
        </div>
      </td>
    </tr>
  )
}

export function MembersPanel({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectMembers>(`/api/v1/projects/${projectId}`),
    enabled: Boolean(projectId),
  })
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => apiRequest<User[]>('/api/v1/users'),
  })

  const [selectedUserId, setSelectedUserId] = useState('')
  const [roles, setRoles] = useState<Record<RoleKey, boolean>>(emptyRoles)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] })

  const addMember = useMutation({
    mutationFn: () => apiRequest<Membership>(`/api/v1/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: selectedUserId, ...roles }),
    }),
    onSuccess: () => {
      setSelectedUserId('')
      setRoles(emptyRoles)
      refresh()
    },
  })

  const updateMember = useMutation({
    mutationFn: ({ id, roles: nextRoles }: { id: string; roles: Record<RoleKey, boolean> }) =>
      apiRequest<Membership>(`/api/v1/projects/${projectId}/members/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(nextRoles),
      }),
    onSuccess: refresh,
  })

  const removeMember = useMutation({
    mutationFn: (id: string) =>
      apiRequest(`/api/v1/projects/${projectId}/members/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  })

  if (project.isLoading) return <p>Loading project members…</p>
  if (project.isError || !project.data) {
    return <p className="error" role="alert">Project members could not be loaded.</p>
  }

  const usersById = new Map((users.data ?? []).map((user) => [user.id, user]))
  const memberIds = new Set(project.data.memberships.map((membership) => membership.userId))
  const availableUsers = (users.data ?? []).filter((user) => !memberIds.has(user.id))
  const memberPending = updateMember.isPending || removeMember.isPending
  const mutationError = addMember.error ?? updateMember.error ?? removeMember.error

  return (
    <CollapsibleSection id="section-project-members" title="Project Members">
      {users.error ? <p className="error" role="alert">{users.error.message}</p> : null}
      {mutationError ? <p className="error" role="alert">{mutationError.message}</p> : null}
      <table>
        <thead>
          <tr>
            <th scope="col">Reviewer</th>
            <th scope="col">Roles</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {project.data.memberships.length === 0 ? (
            <tr>
              <td colSpan={3}>No members yet.</td>
            </tr>
          ) : null}
          {project.data.memberships.map((membership) => {
            const user = usersById.get(membership.userId)
            const label = user ? `${user.displayName} (${user.username})` : membership.userId
            return (
              <MemberRow
                key={membership.id}
                label={label}
                membership={membership}
                pending={memberPending}
                onSave={(nextRoles) => updateMember.mutate({ id: membership.id, roles: nextRoles })}
                onDelete={() => removeMember.mutate(membership.id)}
              />
            )
          })}
        </tbody>
      </table>
      <form onSubmit={(event) => { event.preventDefault(); addMember.mutate() }}>
        <label>
          Reviewer
          <select
            value={selectedUserId}
            onChange={(event) => setSelectedUserId(event.target.value)}
            required
          >
            <option value="" disabled>Select a reviewer…</option>
            {availableUsers.map((user) => (
              <option key={user.id} value={user.id}>{user.displayName} ({user.username})</option>
            ))}
          </select>
        </label>
        {selectedUserId ? (
          <fieldset>
            <legend className="subsection-heading">Stages</legend>
            {ROLE_FIELDS.map(([field, label]) => (
              <label key={field}>
                <input
                  type="checkbox"
                  checked={roles[field]}
                  onChange={(event) => setRoles({ ...roles, [field]: event.target.checked })}
                />
                {label}
              </label>
            ))}
          </fieldset>
        ) : null}
        <button type="submit" disabled={addMember.isPending || selectedUserId === ''}>
          Add Member
        </button>
      </form>
    </CollapsibleSection>
  )
}
