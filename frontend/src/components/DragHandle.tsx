import { useRef } from 'react'
import type { DragEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react'

import { IconDragHandle } from './icons'
import { IconButton } from './Button'

interface DragHandleProps {
  label: string
  index: number
  itemCount: number
  onMove: (targetIndex: number) => void
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
  onPointerDragStart: () => void
  onPointerDragOver: (targetKey: string | null) => void
  onPointerDrop: (targetKey: string | null) => void
  onPointerDragCancel: () => void
  disabled?: boolean
}

function fieldKeyAtPoint(clientX: number, clientY: number) {
  const element = document.elementFromPoint?.(clientX, clientY)
  return element?.closest<HTMLElement>('[data-field-sort-key]')?.dataset.fieldSortKey ?? null
}

export function DragHandle({
  label,
  index,
  itemCount,
  onMove,
  onDragStart,
  onDragEnd,
  onPointerDragStart,
  onPointerDragOver,
  onPointerDrop,
  onPointerDragCancel,
  disabled = false,
}: DragHandleProps) {
  const activePointerId = useRef<number | null>(null)

  const stopSummaryToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault()
      event.stopPropagation()
      onMove(index - 1)
    }
    if (event.key === 'ArrowDown' && index < itemCount - 1) {
      event.preventDefault()
      event.stopPropagation()
      onMove(index + 1)
    }
  }

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (disabled || event.pointerType === 'mouse') return
    event.preventDefault()
    event.stopPropagation()
    activePointerId.current = event.pointerId
    event.currentTarget.setPointerCapture?.(event.pointerId)
    onPointerDragStart()
  }

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (activePointerId.current !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    onPointerDragOver(fieldKeyAtPoint(event.clientX, event.clientY))
  }

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (activePointerId.current !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    const targetKey = fieldKeyAtPoint(event.clientX, event.clientY)
    activePointerId.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onPointerDrop(targetKey)
  }

  const handlePointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    if (activePointerId.current !== event.pointerId) return
    activePointerId.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    onPointerDragCancel()
  }

  return (
    <IconButton
      type="button"
      variant="ghost"
      size="sm"
      className="col-start-2 row-span-3 row-start-1 self-center cursor-grab touch-none border-transparent select-none active:cursor-grabbing pointer-coarse:size-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 [&_svg]:size-[18px]"
      draggable={!disabled}
      disabled={disabled}
      aria-label={`Reorder ${label}`}
      title="Drag to reorder. Use the up and down arrow keys when focused."
      onClick={stopSummaryToggle}
      onKeyDown={handleKeyDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <IconDragHandle />
    </IconButton>
  )
}
