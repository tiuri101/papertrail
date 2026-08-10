import { type ReactNode, useId, useState } from 'react'

import { IconHelpCircle } from './icons'

type TooltipPlacement = 'top' | 'bottom'

interface TooltipBubbleProps {
  id: string
  text: string
  visible: boolean
  placement: TooltipPlacement
}

function TooltipBubble({ id, text, visible, placement }: TooltipBubbleProps) {
  const className = placement === 'bottom' ? 'tooltip-bubble tooltip-bubble--bottom' : 'tooltip-bubble'
  return (
    <span role="tooltip" id={id} className={className} hidden={!visible}>
      {text}
    </span>
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
  const { visible, handlers } = useHoverable()

  return (
    <span className="tooltip-anchor" tabIndex={0} aria-describedby={tooltipId} {...handlers}>
      {children}
      <TooltipBubble id={tooltipId} text={text} visible={visible} placement={placement} />
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
  const { visible, handlers } = useHoverable()

  return (
    <span className="tooltip-anchor">
      <button
        type="button"
        className="info-tooltip__trigger"
        aria-describedby={tooltipId}
        aria-label={label}
        {...handlers}
      >
        <IconHelpCircle />
      </button>
      <TooltipBubble id={tooltipId} text={text} visible={visible} placement={placement} />
    </span>
  )
}
