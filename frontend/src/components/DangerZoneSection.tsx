import type { ReactNode } from 'react'

import { CollapsibleSection } from './CollapsibleSection'
import { ConfirmButton, type ConfirmButtonProps } from './ConfirmButton'
import { IconAlertTriangle } from './icons'
import { InfoBox } from './InfoBox'

interface DangerZoneSectionProps {
  id: string
  title: string
  /** Identifies the action in the section header; the warning box always uses the alert icon. */
  icon: ReactNode
  /** What the action does and what it changes or cannot undo, shown in the warning box. */
  description: ReactNode
  children: ReactNode
}

// Recolours the shared form controls (FieldLabel, Select) an entry places in its controls, so a
// stage picker reads as part of the danger action instead of keeping the default blue field style.
// Descendant selectors outrank the controls' own single-class utilities, including their
// hover/focus variants, so these win without editing every control.
const dangerControlStyles = [
  '[&_label]:text-danger',
  '[&_select]:border-danger/40 [&_select]:bg-danger-container [&_select]:text-danger',
  // The open option list is drawn by the OS; give it a solid surface, not the translucent tint.
  '[&_option]:bg-surface [&_option]:text-text',
  '[&_select:hover]:border-danger/70',
  '[&_select:focus]:border-danger [&_select:focus]:bg-danger-container',
  '[&_select:focus]:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-danger)_28%,transparent)]',
].join(' ')

/**
 * The shared shell of every project Danger Zone entry: a danger-toned section with a warning box
 * explaining the consequences, followed by the entry's controls. Pair it with
 * {@link DangerZoneConfirmButton} so every entry looks and confirms the same way.
 */
export function DangerZoneSection({ id, title, icon, description, children }: DangerZoneSectionProps) {
  return (
    // Styles go on the section, not on a wrapper around `children`: the section spaces its direct
    // children, and a wrapper would collapse the entry's controls into one unspaced child.
    <CollapsibleSection id={id} title={title} tone="danger" icon={icon} className={dangerControlStyles}>
      <InfoBox icon={<IconAlertTriangle />} tone="warning">
        <p>{description}</p>
      </InfoBox>
      {children}
    </CollapsibleSection>
  )
}

export function DangerZoneConfirmButton(props: Omit<ConfirmButtonProps, 'variant'>) {
  return <ConfirmButton {...props} variant="danger" />
}
