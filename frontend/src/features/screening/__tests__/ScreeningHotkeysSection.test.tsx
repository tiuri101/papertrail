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

    expect(screen.getByRole('button', { name: 'Include I' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exclude E' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Uncertain U' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Duplicate D' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit / Confirm Enter' })).toBeInTheDocument()
  })

  it('captures a new key and persists it to storage', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Include I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include Press a key…' }), { key: 'k' })

    expect(screen.getByRole('button', { name: 'Include K' })).toBeInTheDocument()
    expect(loadScreeningHotkeys().include).toBe('k')
  })

  it('clears a hotkey with Backspace', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Include I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include Press a key…' }), { key: 'Backspace' })

    expect(screen.getByRole('button', { name: 'Include Not set' })).toBeInTheDocument()
    expect(loadScreeningHotkeys().include).toBeNull()
  })

  it('warns when two actions share the same key', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Exclude E' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Exclude Press a key…' }), { key: 'i' })

    expect(screen.getByRole('alert')).toHaveTextContent('Two actions share the same key')
  })

  it('captures Enter as a hotkey', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate D' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Duplicate Press a key…' }), { key: 'Enter' })

    expect(screen.getByRole('button', { name: 'Duplicate Enter' })).toBeInTheDocument()
    expect(loadScreeningHotkeys().duplicate).toBe('Enter')
  })

  it('resets to the default hotkeys', () => {
    render(<ScreeningHotkeysSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Include I' }))
    fireEvent.keyDown(screen.getByRole('button', { name: 'Include Press a key…' }), { key: 'k' })
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))

    expect(screen.getByRole('button', { name: 'Include I' })).toBeInTheDocument()
    expect(loadScreeningHotkeys().include).toBe('i')
  })
})
