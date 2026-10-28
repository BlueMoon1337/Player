import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  /** The button it points at. */
  anchor: DOMRect
  className?: string
  /** A press on an element matching this (the anchor button) is left to that button, to toggle. */
  ignore?: string
  onClose: () => void
  /** Escape closes it unless this returns true (e.g. it went back a page instead). */
  onEscape?: () => boolean
  children: ReactNode
}

/**
 * A popover beside a button, with an arrow pointing at it, as in Playback: to the button's right
 * when there's room, else to its left. A press outside, Escape or a resize closes it.
 */
export function Popover({ anchor, className = '', ignore, onClose, onEscape, children }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number; side: 'left' | 'right' } | null>(null)

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const place = () => {
      const w = el.offsetWidth
      const h = el.offsetHeight
      const gap = 14
      const side = anchor.right + gap + w <= window.innerWidth - 8 ? 'right' : 'left'
      const left = side === 'right' ? anchor.right + gap : Math.max(8, anchor.left - gap - w)
      const mid = anchor.top + anchor.height / 2
      const top = Math.max(8, Math.min(window.innerHeight - h - 8, mid - 30))
      setPos({ left, top, side, arrow: Math.max(18, Math.min(h - 18, mid - top)) })
    }
    place()
    // Its height changes as it goes from page to page.
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [anchor])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element
      if (!box.current?.contains(t) && !(ignore && t.closest?.(ignore)) && !t.closest?.('.ctx-menu, .ask-backdrop')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (!onEscape?.()) onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, onEscape, ignore])

  return createPortal(
    <div
      ref={box}
      className={`popover arrow-${pos?.side ?? 'right'} ${className}`}
      style={pos ? { left: pos.left, top: pos.top, ['--arrow-y' as string]: `${pos.arrow}px` } : { visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}
