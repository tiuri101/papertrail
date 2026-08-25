import { cn } from '../lib/cn'

export type StatusPillTone = 'success' | 'warning' | 'danger' | 'neutral'

/** Small rounded status indicator (e.g. validation/PDF-match state). */
export function statusPillClass(tone?: StatusPillTone) {
  return cn(
    'inline-flex flex-none items-center whitespace-nowrap rounded-full px-[10px] py-1 text-[0.74rem] font-[720]',
    tone === 'success' && 'bg-success-container text-success',
    tone === 'warning' && 'bg-warning-container text-warning',
    tone === 'danger' && 'bg-danger-container text-danger',
    (!tone || tone === 'neutral') && 'bg-surface-hover text-text-secondary',
  )
}
