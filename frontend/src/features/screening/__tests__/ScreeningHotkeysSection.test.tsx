import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { ScreeningHotkeysSection } from '../ScreeningHotkeysSection'
import { loadScreeningHotkeys } from '../../../lib/screeningHotkeys'

describe('ScreeningHotkeysSection', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('shows the default hotkeys', () => {
    render(<ScreeningHotkeysSection />)

    expect(screen.getByRole('button', { name: 'Include hotkey: I' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exclude hotkey: E' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Uncertain hotkey: U' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Duplicate hotkey: D' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit / Confirm hotkey: Enter' })).toBeInTheDocument()
  })

  it('captures a new key and persists it to storage', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Include hotkey: I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include hotkey: Press a key…' }), { key: 'k' })

    expect(screen.getByRole('button', { name: 'Include hotkey: K' })).toBeInTheDocument()
    expect(loadScreeningHotkeys().include).toBe('k')
  })

  it('clears a hotkey with Backspace', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Include hotkey: I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include hotkey: Press a key…' }), { key: 'Backspace' })

    expect(screen.getByRole('button', { name: 'Include hotkey: Not set' })).toBeInTheDocument()
    expect(loadScreeningHotkeys().include).toBeNull()
  })

  it('warns when two actions share the same key', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Exclude hotkey: E' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Exclude hotkey: Press a key…' }), { key: 'i' })

    expect(screen.getByRole('alert')).toHaveTextContent('Two actions share the same key')
  })

  it('captures Enter as a hotkey', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate hotkey: D' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Duplicate hotkey: Press a key…' }), { key: 'Enter' })

    expect(screen.getByRole('button', { name: 'Duplicate hotkey: Enter' })).toBeInTheDocument()
    expect(loadScreeningHotkeys().duplicate).toBe('Enter')
  })

  it('resets to the default hotkeys', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Include hotkey: I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include hotkey: Press a key…' }), { key: 'k' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))

    expect(screen.getByRole('button', { name: 'Include hotkey: I' })).toBeInTheDocument()
    expect(loadScreeningHotkeys().include).toBe('i')
  })
})
