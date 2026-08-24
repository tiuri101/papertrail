import { tableCompactClass, toolbarClass } from '../../components/layoutStyles'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { apiRequest } from '../../api/client'
import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { ConfirmButton } from '../../components/ConfirmButton'
import { CountPill } from '../../components/CountPill'
import { IconCheckCircle, IconPlus, IconTrash, IconUsers } from '../../components/icons'
import { InfoBox } from '../../components/InfoBox'
import { Input } from '../../components/Input'
import { Select } from '../../components/Select'
import type { User } from '../auth/types'
import type { ProjectMembers as ProjectMembersOf } from './types'
import { FieldLabel } from '../../components/FieldLabel'
import { Form } from '../../components/Form'
import { Fieldset } from '../../components/Fieldset'

type RoleKey =
  | 'canTitleAbstractScreen'
  | 'canFullTextScreen'
  | 'canExtract'
  | 'canAssessQuality'
  | 'canAdjudicate'

interface Membership extends Record<RoleKey, boolean> {
  id: string
  userId: string
  workloadWeight: number
}

type ProjectMembers = ProjectMembersOf<Membership>

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
  onDirtyChange,
}: {
  label: string
  membership: Membership
  onSave: (roles: Record<RoleKey, boolean>, workloadWeight: number) => void
  onDelete: () => void
  pending: boolean
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<RoleKey, boolean>>(rolesOf(membership))
  const [weight, setWeight] = useState(String(membership.workloadWeight))

  useEffect(() => {
    const saved = rolesOf(membership)
    onDirtyChange?.(
      editing
      && (ROLE_FIELDS.some(([field]) => draft[field] !== saved[field])
        || weight !== String(membership.workloadWeight)),
    )
  }, [editing, draft, weight, membership, onDirtyChange])

  if (editing) {
    return (
      <tr>
        <td>{label}</td>
        <td colSpan={2}>
          <Form
            onSubmit={(event) => {
              event.preventDefault()
              setEditing(false)
              onSave(draft, Number(weight))
            }}
          >
            <Fieldset>
              <legend className="mb-3 text-base font-semibold leading-[1.2] text-text">Stages</legend>
              {ROLE_FIELDS.map(([field, fieldLabel]) => (
                <FieldLabel key={field} inline>
                  <Input
                    type="checkbox"
                    checked={draft[field]}
                    onChange={(event) => setDraft({ ...draft, [field]: event.target.checked })}
                  />
                  {fieldLabel}
                </FieldLabel>
              ))}
            </Fieldset>
            <FieldLabel>
              Workload weight
              <Input
                type="number"
                min={0.1}
                max={100}
                step={0.1}
                className="max-w-20"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                required
              />
            </FieldLabel>
            <div className={toolbarClass}>
              <Button type="submit" disabled={pending}><IconCheckCircle />Save</Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDraft(rolesOf(membership))
                  setWeight(String(membership.workloadWeight))
                  setEditing(false)
                }}
              >
                Cancel
              </Button>
            </div>
          </Form>
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
      <td>
        {activeRoles.length > 0 ? activeRoles.join(', ') : 'No roles assigned'}
        <span className="text-text-muted">. Weight: {membership.workloadWeight}.</span>
      </td>
      <td>
        <div className={toolbarClass}>
          <Button type="button" onClick={() => setEditing(true)} disabled={pending}>Edit</Button>
          <ConfirmButton
            label="Remove"
            warning="Remove this reviewer from the project? This cannot be undone."
            onConfirm={onDelete}
            disabled={pending}
            variant="danger"
            icon={<IconTrash />}
          />
        </div>
      </td>
    </tr>
  )
}

export function MembersPanel({
  projectId,
  onDirtyChange,
}: {
  projectId: string
  onDirtyChange?: (dirty: boolean) => void
}) {
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
  const [newWeight, setNewWeight] = useState('1')
  const [dirtyRows, setDirtyRows] = useState<Record<string, boolean>>({})

  useEffect(() => {
    onDirtyChange?.(selectedUserId !== '' || Object.values(dirtyRows).some(Boolean))
  }, [selectedUserId, dirtyRows, onDirtyChange])

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['project', projectId] })

  const addMember = useMutation({
    mutationFn: () => apiRequest<Membership>(`/api/v1/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: selectedUserId, ...roles, workloadWeight: Number(newWeight) }),
    }),
    onSuccess: () => {
      setSelectedUserId('')
      setRoles(emptyRoles)
      setNewWeight('1')
      refresh()
    },
  })

  const updateMember = useMutation({
    mutationFn: ({ id, roles: nextRoles, workloadWeight }: {
      id: string
      roles: Record<RoleKey, boolean>
      workloadWeight: number
    }) =>
      apiRequest<Membership>(`/api/v1/projects/${projectId}/members/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...nextRoles, workloadWeight }),
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
    return <p className="text-danger" role="alert">Project members could not be loaded.</p>
  }

  const usersById = new Map((users.data ?? []).map((user) => [user.id, user]))
  const memberIds = new Set(project.data.memberships.map((membership) => membership.userId))
  const availableUsers = (users.data ?? []).filter(
    (user) => !memberIds.has(user.id) && user.isActive,
  )
  const memberPending = updateMember.isPending || removeMember.isPending
  const mutationError = addMember.error ?? updateMember.error ?? removeMember.error

  return (
    <CollapsibleSection id="section-project-members" title="Project Members" icon={<IconUsers />}>
      <InfoBox icon={<IconUsers />}>
        <p>
          Add the reviewers who will work on this project and choose which stages each one can
          take part in. Reviewers only see the stages they&apos;re given a role for. Workload
          weight controls how publications are split when a stage pre-assigns work rather than
          letting reviewers claim it themselves: A reviewer with weight 2 gets roughly twice as
          many publications as one with weight 1.
        </p>
      </InfoBox>
      {users.error ? <p className="text-danger" role="alert">{users.error.message}</p> : null}
      {mutationError ? <p className="text-danger" role="alert">{mutationError.message}</p> : null}
      <CountPill count={project.data.memberships.length}>
        project member{project.data.memberships.length === 1 ? '' : 's'}
      </CountPill>
      <table className={tableCompactClass}>
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
                onSave={(nextRoles, workloadWeight) => updateMember.mutate({
                  id: membership.id, roles: nextRoles, workloadWeight,
                })}
                onDelete={() => removeMember.mutate(membership.id)}
                onDirtyChange={(rowDirty) => setDirtyRows((current) => (
                  current[membership.id] === rowDirty ? current : { ...current, [membership.id]: rowDirty }
                ))}
              />
            )
          })}
        </tbody>
      </table>
      <Form onSubmit={(event) => { event.preventDefault(); addMember.mutate() }}>
        <FieldLabel>
          Reviewer
          <Select
            value={selectedUserId}
            onChange={(event) => setSelectedUserId(event.target.value)}
            required
          >
            <option value="" disabled>Select a reviewer…</option>
            {availableUsers.map((user) => (
              <option key={user.id} value={user.id}>{user.displayName} ({user.username})</option>
            ))}
          </Select>
        </FieldLabel>
        {selectedUserId ? (
          <>
            <Fieldset>
              <legend className="mb-3 text-base font-semibold leading-[1.2] text-text">Stages</legend>
              {ROLE_FIELDS.map(([field, label]) => (
                <FieldLabel key={field} inline>
                  <Input
                    type="checkbox"
                    checked={roles[field]}
                    onChange={(event) => setRoles({ ...roles, [field]: event.target.checked })}
                  />
                  {label}
                </FieldLabel>
              ))}
            </Fieldset>
            <FieldLabel>
              Workload weight
              <Input
                type="number"
                min={0.1}
                max={100}
                step={0.1}
                className="max-w-20"
                value={newWeight}
                onChange={(event) => setNewWeight(event.target.value)}
                required
              />
            </FieldLabel>
          </>
        ) : null}
        <Button type="submit" disabled={addMember.isPending || selectedUserId === ''}>
          <IconPlus />
          Add Member
        </Button>
      </Form>
    </CollapsibleSection>
  )
}
