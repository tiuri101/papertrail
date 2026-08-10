import { type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { IconHelpCircle } from './icons'

type TooltipPlacement = 'top' | 'bottom'

interface TooltipBubbleProps {
  anchorRef: RefObject<HTMLElement | null>
  id: string
  text: string
  visible: boolean
  placement: TooltipPlacement
}

function TooltipBubble({ anchorRef, id, text, visible, placement }: TooltipBubbleProps) {
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const className = placement === 'bottom' ? 'tooltip-bubble tooltip-bubble--bottom' : 'tooltip-bubble'

  useLayoutEffect(() => {
    if (!visible) return

    const anchor = anchorRef.current
    const bubble = bubbleRef.current
    if (!anchor || !bubble) return

    const updatePosition = () => {
      const anchorRect = anchor.getBoundingClientRect()
      const bubbleRect = bubble.getBoundingClientRect()
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth
      const viewportMargin = 8
      const gap = 8
      const anchorCenter = anchorRect.left + anchorRect.width / 2
      const halfBubbleWidth = bubbleRect.width / 2
      const left = Math.min(
        Math.max(anchorCenter, viewportMargin + halfBubbleWidth),
        viewportWidth - viewportMargin - halfBubbleWidth,
      )
      const arrowLeft = Math.min(
        Math.max(anchorCenter - left + halfBubbleWidth, viewportMargin),
        Math.max(viewportMargin, bubbleRect.width - viewportMargin),
      )

      bubble.style.left = `${left}px`
      bubble.style.top = `${placement === 'bottom' ? anchorRect.bottom + gap : anchorRect.top - gap}px`
      bubble.style.setProperty('--tooltip-arrow-left', `${arrowLeft}px`)
      bubble.style.visibility = 'visible'
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef, placement, visible])

  if (typeof document === 'undefined') return null

  return createPortal(
    <span
      ref={bubbleRef}
      role="tooltip"
      id={id}
      className={className}
      hidden={!visible}
      style={{ visibility: 'hidden' }}
    >
      {text}
    </span>,
    document.body,
  )
}

function useHoverable() {
  const [visible, setVisible] = useState(false)
  return {
    visible,
    handlers: {
      onMouseEnter: () => setVisible(true),
      onMouseLeave: () => setVisible(false),
      onFocus: () => setVisible(true),
      onBlur: () => setVisible(false),
    },
  }
}

/** Wraps inline content (text, a badge, a heading) with a tooltip shown on hover or keyboard focus. */
export function Tooltip({
  text,
  children,
  placement = 'top',
}: {
  text: string
  children: ReactNode
  placement?: TooltipPlacement
}) {
  const tooltipId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { visible, handlers } = useHoverable()

  return (
    <span ref={anchorRef} className="tooltip-anchor" tabIndex={0} aria-describedby={tooltipId} {...handlers}>
      {children}
      <TooltipBubble anchorRef={anchorRef} id={tooltipId} text={text} visible={visible} placement={placement} />
    </span>
  )
}

/** A standalone help icon that reveals an explanatory tooltip, for use next to labels/headings with no other hoverable element. */
export function InfoTooltip({
  text,
  label = 'More information',
  placement = 'top',
}: {
  text: string
  label?: string
  placement?: TooltipPlacement
}) {
  const tooltipId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { visible, handlers } = useHoverable()

  return (
    <span ref={anchorRef} className="tooltip-anchor">
      <button
        type="button"
        className="info-tooltip__trigger"
        aria-describedby={tooltipId}
        aria-label={label}
        {...handlers}
      >
        <IconHelpCircle />
      </button>
      <TooltipBubble anchorRef={anchorRef} id={tooltipId} text={text} visible={visible} placement={placement} />
    </span>
  )
}
