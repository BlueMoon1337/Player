import { useRef } from 'react'

interface Props {
  value: number
  onChange: (v: number) => void
  label: string
  /** Called with a ref setter so a parent animation loop can drive the meter. */
  meterRef?: (el: HTMLDivElement | null) => void
}

const UNITY = 0.75

/** Vertical fader with drag, wheel and keyboard control. Double-click resets to unity. */
export function Fader({ value, onChange, label, meterRef }: Props) {
  const track = useRef<HTMLDivElement>(null)

  const fromPointer = (clientY: number) => {
    const r = track.current!.getBoundingClientRect()
    const v = 1 - (clientY - r.top) / r.height
    onChange(Math.max(0, Math.min(1, v)))
  }

  return (
    <div
      className="fader"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={value}
      tabIndex={0}
      onDoubleClick={() => onChange(UNITY)}
      onWheel={(e) => onChange(Math.max(0, Math.min(1, value - Math.sign(e.deltaY) * 0.02)))}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') onChange(Math.min(1, value + 0.02))
        else if (e.key === 'ArrowDown') onChange(Math.max(0, value - 0.02))
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        className="fader-track"
        ref={track}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          fromPointer(e.clientY)
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) fromPointer(e.clientY)
        }}
      >
        <div className="fader-meter" ref={meterRef} />
        <div className="fader-unity" style={{ bottom: `${UNITY * 100}%` }} />
        <div className="fader-fill" style={{ height: `${value * 100}%` }} />
        <div className="fader-cap" style={{ bottom: `${value * 100}%` }} />
      </div>
    </div>
  )
}
