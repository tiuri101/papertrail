import { useMutation, useQueryClient } from '@tanstack/react-query'

import { apiRequest } from '../../api/client'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { FieldLabel } from '../../components/FieldLabel'
import { IconMail } from '../../components/icons'
import { Input } from '../../components/Input'
import { sessionQueryOptions } from './sessionQuery'
import type { EmailCategory, LoginResponse, User } from './types'

interface CategoryOption {
  key: EmailCategory
  label: string
  description: string
  adminOnly?: boolean
}

// Keys mirror backend `app.notifications.preferences.EMAIL_CATEGORIES`.
const EMAIL_CATEGORY_OPTIONS: CategoryOption[] = [
  {
    key: 'llm_processing',
    label: 'LLM processing finished',
    description: 'One summary per project once all queued LLM work has finished and stayed idle for a few minutes.',
  },
  {
    key: 'imports',
    label: 'Imports',
    description: 'When a file you imported has been processed or failed.',
  },
  {
    key: 'duplicate_detection',
    label: 'Duplicate detection problems',
    description: 'When duplicate detection fails in a project you own.',
  },
  {
    key: 'project_progress',
    label: 'Project progress',
    description: 'When a project you own moves to its next stage or is completed.',
  },
  {
    key: 'project_membership',
    label: 'Project membership',
    description: 'When you are added to or removed from a project.',
  },
  {
    key: 'project_copies',
    label: 'Project copies',
    description: 'When a project copy you requested is ready or failed.',
  },
  {
    key: 'new_projects',
    label: 'New projects',
    description: 'When anyone creates a project on this instance.',
    adminOnly: true,
  },
]

export function EmailNotificationsSection() {
  const queryClient = useQueryClient()
  const user = queryClient.getQueryData<LoginResponse>(sessionQueryOptions.queryKey)?.user

  const mutation = useMutation({
    mutationFn: (change: Partial<Record<EmailCategory, boolean>>) => apiRequest<User>('/api/v1/auth/me', {
      method: 'PATCH',
      body: JSON.stringify({ emailPreferences: change }),
    }),
    onSuccess: (updated) => {
      queryClient.setQueryData<LoginResponse>(sessionQueryOptions.queryKey, (session) =>
        session ? { ...session, user: updated } : session)
    },
  })

  const pending = mutation.isPending ? mutation.variables : undefined
  const enabled = (key: EmailCategory) => pending?.[key] ?? user?.emailPreferences?.[key] ?? true
  const options = EMAIL_CATEGORY_OPTIONS.filter((option) => !option.adminOnly || user?.isAdmin)

  return (
    <CollapsibleSection id="section-account-email" title="Email Notifications" icon={<IconMail />}>
      <p className="text-text-muted">
        Choose which emails Papertrail sends you. Account and password-reset emails are always sent.
      </p>
      {user?.email ? null : (
        <p className="text-text-muted">Add an email address under Profile to receive these emails.</p>
      )}
      <div className="grid gap-3">
        {options.map((option) => (
          <div key={option.key} className="grid gap-1">
            <FieldLabel inline>
              <Input
                type="checkbox"
                checked={enabled(option.key)}
                disabled={mutation.isPending}
                aria-describedby={`email-category-${option.key}`}
                onChange={(event) => mutation.mutate({ [option.key]: event.target.checked })}
              />
              {option.label}
            </FieldLabel>
            <small id={`email-category-${option.key}`} className="text-text-secondary">{option.description}</small>
          </div>
        ))}
      </div>
      {mutation.error ? <p className="text-danger" role="alert">{mutation.error.message}</p> : null}
      <p className="text-text-muted" aria-live="polite">{mutation.isPending ? 'Saving…' : ' '}</p>
    </CollapsibleSection>
  )
}
