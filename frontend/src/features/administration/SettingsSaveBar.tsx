import type { ReactNode } from 'react'

import { Button } from '../../components/Button'
import { IconCheckCircle } from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'
import type { SaveStatus } from './useStructuralSettingsForm'

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  dirty: 'Unsaved changes.',
  saving: 'Saving…',
  saved: 'Saved.',
  error: '',
}

/**
 * Save / Discard controls plus the saving-saved-dirty-error readout shared by
 * the structural settings panels. Errors are rendered by the panel (next to
 * the control they belong to where possible), so this only reports progress.
 */
export function SettingsSaveBar({
  status,
  dirty,
  onSave,
  onRevert,
  label = 'Save Changes',
}: {
  status: SaveStatus
  dirty: boolean
  onSave: () => void
  onRevert: () => void
  label?: string
}) {
  return (
    <div className={toolbarClass}>
      <Button
        type="button"
        onClick={onSave}
        disabled={!dirty || status === 'saving'}
        startIcon={<IconCheckCircle />}
      >
        {label}
      </Button>
      {dirty ? (
        <Button type="button" variant="secondary" onClick={onRevert} disabled={status === 'saving'}>
          Discard
        </Button>
      ) : null}
      <p className="text-text-muted m-0" aria-live="polite">{STATUS_TEXT[status]}</p>
    </div>
  )
}

/**
 * A field plus, when the backend has frozen it, the explanation for why it is
 * disabled.
 *
 * The note is a *sibling* of the field, never a child of it: these panels
 * label controls with a wrapping `<label>`, and text placed inside one becomes
 * part of the control's accessible name -- renaming "Aggregation" to
 * "Aggregation Cannot be changed after…" for every screen reader and query.
 */
export function LockableField({
  locked,
  children,
}: {
  locked?: string
  children: ReactNode
}) {
  if (!locked) return <>{children}</>
  return (
    <div className="grid gap-1">
      {children}
      <p className="text-text-muted m-0 text-[0.8rem]">
        Cannot be changed after work has started. {locked}
      </p>
    </div>
  )
}
