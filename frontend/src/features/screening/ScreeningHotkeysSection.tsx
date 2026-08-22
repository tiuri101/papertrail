import { useState } from 'react'
import type { KeyboardEvent } from 'react'

import { Button } from '../../components/Button'
import { CollapsibleSection } from '../../components/CollapsibleSection'
import { IconKeyboard } from '../../components/icons'
import { toolbarClass } from '../../components/layoutStyles'
import {
  DEFAULT_SCREENING_HOTKEYS,
  formatHotkey,
  loadScreeningHotkeys,
  saveScreeningHotkeys,
  SCREENING_HOTKEY_ACTIONS,
  type ScreeningHotkeyAction,
  type ScreeningHotkeys,
} from '../../lib/screeningHotkeys'

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
  const [hotkeys, setHotkeys] = useState<ScreeningHotkeys>(() => loadScreeningHotkeys())
  const [capturing, setCapturing] = useState<ScreeningHotkeyAction | null>(null)
  const [saved, setSaved] = useState(false)

  const update = (next: ScreeningHotkeys) => {
    setHotkeys(next)
    saveScreeningHotkeys(next)
    setSaved(true)
  }

  const startCapture = (action: ScreeningHotkeyAction) => {
    setSaved(false)
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
      <div className="grid gap-2">
        {SCREENING_HOTKEY_ACTIONS.map((action) => {
          const key = hotkeys[action]
          const hasConflict = key ? conflicts.has(key.toLowerCase()) : false
          const displayKey = key ? formatHotkey(key) : 'Not set'
          return (
            <div key={action} className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
              <span className="w-32 shrink-0 text-sm font-medium text-text-secondary" id={`hotkey-label-${action}`}>{ACTION_LABELS[action]}</span>
              <button
                type="button"
                aria-labelledby={`hotkey-label-${action} hotkey-value-${action}`}
                className={`min-h-9 min-w-24 rounded-md border bg-surface-raised px-3 py-1.5 text-center text-sm font-semibold shadow-none transition-colors hover:bg-surface-hover ${hasConflict ? 'border-danger text-danger' : capturing === action ? 'border-primary text-text ring-2 ring-primary-container' : 'border-border text-text-secondary'}`}
                onClick={() => startCapture(action)}
                onKeyDown={capturing === action ? handleCaptureKeyDown(action) : undefined}
                onBlur={() => setCapturing((current) => (current === action ? null : current))}
              >
                <span id={`hotkey-value-${action}`}>
                  {capturing === action ? 'Press a key…' : key ? <kbd>{displayKey}</kbd> : displayKey}
                </span>
              </button>
            </div>
          )
        })}
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
      <p className="text-text-muted" aria-live="polite">{saved ? 'Saved.' : ' '}</p>
    </CollapsibleSection>
  )
}
