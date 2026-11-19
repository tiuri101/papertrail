/**
 * Shared motion vocabulary. Keep every UI animation in the 150–200ms range and
 * built from these strings so the app moves consistently. Entry animations use
 * Tailwind's `starting:` variant (CSS `@starting-style`), so they need no JS;
 * exit animations pair `data-[state=closed]:` with the `usePresence` hook.
 * The global `prefers-reduced-motion` rule in base.css disables all of it.
 */

/** Dropdown menus and popovers: fade + 4px drop on open, reversed on close. */
export const popoverMotionClass = [
  'transition-[opacity,translate] duration-150 ease-out',
  'starting:-translate-y-1 starting:opacity-0',
  'data-[state=closed]:-translate-y-1 data-[state=closed]:opacity-0 data-[state=closed]:pointer-events-none',
].join(' ')

/** Modal backdrops: plain fade. */
export const backdropMotionClass = [
  'transition-opacity duration-200 ease-out starting:opacity-0',
  'data-[state=closed]:opacity-0 data-[state=closed]:pointer-events-none',
].join(' ')

/** Modal surfaces: fade + slight scale-up on open. */
export const dialogMotionClass = [
  'transition-[opacity,scale] duration-200 ease-out starting:scale-[0.98] starting:opacity-0',
  'data-[state=closed]:scale-[0.98] data-[state=closed]:opacity-0',
].join(' ')

/** Side drawer sliding in from the left edge. */
export const drawerMotionClass = [
  'transition-[opacity,translate] duration-200 ease-out starting:-translate-x-4 starting:opacity-0',
  'data-[state=closed]:-translate-x-4 data-[state=closed]:opacity-0',
].join(' ')

/** Content that appears in place (alerts, inline confirmations, swapped cards): fade + 4px rise. */
export const appearMotionClass = 'transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0'

/** Content that should simply fade in where it is (tab panels, freshly loaded tables). */
export const fadeInMotionClass = 'transition-opacity duration-200 ease-out starting:opacity-0'

/** Exit for in-place content managed by `usePresence`: fade + 4px rise reversed. */
export const disappearMotionClass = 'data-[state=closed]:translate-y-1 data-[state=closed]:opacity-0'

/** Tactile press feedback for buttons. */
export const pressMotionClass = 'active:not-disabled:scale-[0.98]'
