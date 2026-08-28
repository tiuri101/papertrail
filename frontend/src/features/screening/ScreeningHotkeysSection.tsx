import { useState } from 'react'
import type { KeyboardEvent } from 'react'

import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconKeyboard } from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'
import { useUiPreference } from '../../hooks/useUiPreferences'
import {
  DEFAULT_SCREENING_HOTKEYS,
  formatHotkey,
  SCREENING_HOTKEY_ACTIONS,
  SCREENING_HOTKEYS_PREFERENCE_KEY,
  type ScreeningHotkeyAction,
  type ScreeningHotkeys,
} from '../../lib/screeningHotkeys'
import { HotkeyButton } from './HotkeyButton'

const ACTION_LABELS: Record<ScreeningHotkeyAction, string> = {
  include: 'Include',
  exclude: 'Exclude',
  uncertain: 'Uncertain',
  duplicate: 'Duplicate',
  submit: 'Submit / Confirm',
}

function duplicateKeys(hotkeys: ScreeningHotkeys): Set<string> {
  const seen = new Map<string, number>()
  SCREENING_HOTKEY_ACTIONS.forEach((action) => {
    const key = hotkeys[action]?.toLowerCase()
    if (!key) return
    seen.set(key, (seen.get(key) ?? 0) + 1)
  })
  return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key))
}

export function ScreeningHotkeysSection() {
  const { value: hotkeys, setValue: update, isSaving, error } = useUiPreference<ScreeningHotkeys>(
    SCREENING_HOTKEYS_PREFERENCE_KEY,
    DEFAULT_SCREENING_HOTKEYS,
  )
  const [capturing, setCapturing] = useState<ScreeningHotkeyAction | null>(null)

  const startCapture = (action: ScreeningHotkeyAction) => {
    setCapturing(action)
  }

  const handleCaptureKeyDown = (action: ScreeningHotkeyAction) => (event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault()
    if (event.key === 'Escape') {
      setCapturing(null)
      return
    }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      update({ ...hotkeys, [action]: null })
      setCapturing(null)
      return
    }
    if (event.key === 'Tab' || event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') {
      return
    }
    update({ ...hotkeys, [action]: event.key })
    setCapturing(null)
  }

   const conflicts = duplicateKeys(hotkeys)

   return (
     <CollapsibleSection id="section-account-hotkeys" title="Screening Hotkeys" icon={<IconKeyboard />}>
       <p className="text-text-muted">
         Assign a keyboard shortcut for each screening decision, plus one to submit or confirm it, so
         you can quickly move through papers. Click a field and press the key you
         want to use. Press Backspace to clear it.
       </p>
       <div className="flex justify-start">
         <div className="grid gap-2">
           {SCREENING_HOTKEY_ACTIONS.map((action) => {
             const key = hotkeys[action]
             const hasConflict = key ? conflicts.has(key.toLowerCase()) : false
             const displayKey = key ? formatHotkey(key) : null
             return (
               <div key={action} className="flex items-center gap-3">
                 <span className="w-40 shrink-0 text-sm font-medium text-text-secondary">
                   {ACTION_LABELS[action]}
                 </span>
                 <HotkeyButton
                   label={ACTION_LABELS[action]}
                   currentKey={displayKey}
                   isCapturing={capturing === action}
                   hasConflict={hasConflict}
                   onStartCapture={() => startCapture(action)}
                   onKeyDown={capturing === action ? handleCaptureKeyDown(action) : undefined}
                   onBlur={() => setCapturing((current) => (current === action ? null : current))}
                 />
               </div>
             )
           })}
         </div>
       </div>
      {conflicts.size > 0 ? (
        <p className="text-danger" role="alert">
          Two actions share the same key. Only one will trigger when you press it.
        </p>
      ) : null}
      <div className={toolbarClass}>
        <Button type="button" variant="secondary" onClick={() => update({ ...DEFAULT_SCREENING_HOTKEYS })}>
          Reset to defaults
        </Button>
      </div>
      {error ? <p className="text-danger" role="alert">{error.message}</p> : null}
      <p className="text-text-muted" aria-live="polite">{isSaving ? 'Saving…' : ' '}</p>
    </CollapsibleSection>
  )
}
