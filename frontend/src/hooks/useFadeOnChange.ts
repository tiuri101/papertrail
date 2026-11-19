import { type RefObject, useLayoutEffect, useRef } from 'react'

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Replays a short fade (optionally with a 4px rise) on `ref`'s element whenever
 * `changeKey` changes — but not on first mount. Uses the Web Animations API so
 * the element is not remounted and its subtree keeps its state, unlike keying
 * it to force a CSS `@starting-style` entry.
 *
 * The CSS reduced-motion override in base.css doesn't reach WAAPI animations,
 * so the preference is checked here explicitly.
 */
export function useFadeOnChange(ref: RefObject<HTMLElement | null>, changeKey: unknown, { rise = false } = {}) {
  const previousKey = useRef(changeKey)

  useLayoutEffect(() => {
    if (Object.is(previousKey.current, changeKey)) return
    previousKey.current = changeKey
    const element = ref.current
    if (!element || typeof element.animate !== 'function' || prefersReducedMotion()) return
    element.animate(
      rise
        ? [{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration: 200, easing: 'ease-out' },
    )
  }, [ref, changeKey, rise])
}
