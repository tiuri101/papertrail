import { type ReactNode, type RefObject, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../lib/cn'
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
      className={cn(
        "pointer-events-none fixed top-0 left-0 z-[2147483647] w-max max-w-[260px] -translate-x-1/2 rounded-sm border border-(--tooltip-border) bg-(--tooltip-bg) px-2.5 py-2 text-[0.78rem] leading-[1.4] font-medium tracking-normal text-(--tooltip-text) normal-case shadow-[0_6px_18px_rgba(0,0,0,0.28)] invisible after:absolute after:top-full after:left-(--tooltip-arrow-left) after:-translate-x-1/2 after:border-5 after:border-transparent after:border-t-(--tooltip-border) after:content-['']",
        placement === 'top'
          ? '-translate-y-full'
          : 'after:top-auto after:bottom-full after:border-t-transparent after:border-b-(--tooltip-border)',
      )}
      data-placement={placement}
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
  className,
}: {
  text: string
  children: ReactNode
  placement?: TooltipPlacement
  className?: string
}) {
  const tooltipId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { visible, handlers } = useHoverable()

  return (
    <span ref={anchorRef} className={cn('relative inline-flex items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus', className)} tabIndex={0} aria-describedby={tooltipId} data-tooltip-anchor {...handlers}>
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
  className,
}: {
  text: string
  label?: string
  placement?: TooltipPlacement
  className?: string
}) {
  const tooltipId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { visible, handlers } = useHoverable()

  return (
    <span ref={anchorRef} className={cn('relative inline-flex items-center rounded-sm', className)} data-tooltip-anchor>
      <button
        type="button"
        className="ml-[5px] inline-flex size-4 min-h-0 cursor-help items-center justify-center border-0 bg-none p-0 text-text-muted shadow-none hover:text-primary focus-visible:rounded-full focus-visible:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus [&_svg]:size-full [&_svg]:fill-current"
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
